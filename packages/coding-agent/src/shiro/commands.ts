// Slash commands for the trust system and the work graph: /permissions, /hooks, /checkpoint, /rewind and /audit.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../core/extensions/types.ts";
import type { HookHandler } from "./hooks/index.ts";
import { PERMISSION_MODES, type PermissionMode, type PermissionRule } from "./policy/index.ts";
import type { ShiroSession } from "./session.ts";
import {
	auditTrail,
	changedFiles,
	type FileChangeSummary,
	project,
	type RewindPlan,
	type WorkEventOf,
} from "./workgraph/index.ts";

/** What the commands need from the runtime that registers them. */
export interface ShiroHost {
	/** The state of the session `ctx` belongs to. */
	current(ctx: ExtensionContext): ShiroSession;
	/** Switch the permission mode for this session and the ones that follow. Throws when policy forbids it. */
	setMode(mode: PermissionMode, ctx: ExtensionContext): void;
}

const MODE_SUMMARY: Record<PermissionMode, string> = {
	default: "reads run; edits and commands ask first",
	acceptEdits: "reads and edits inside the workspace run; commands ask first",
	plan: "read-only; edits and commands that change things are refused",
	dontAsk: "whatever would ask is refused instead",
	bypassPermissions: "everything that is not denied runs without asking",
};

/** Checkpoints offered in the /rewind picker; older ones are reachable by number. */
const REWIND_PICKER_SIZE = 20;

/** Decisions /audit shows when no count is given. */
const DEFAULT_AUDIT_COUNT = 20;

const FILES_AND_CONVERSATION = "Restore files and conversation";
const FILES_ONLY = "Restore files only";
const CONVERSATION_ONLY = "Restore conversation only";
const KEEP_OUTSIDE_CHANGES = "Restore the rest, keep these files as they are";
const OVERWRITE_OUTSIDE_CHANGES = "Restore everything, overwrite these files";
const CANCEL = "Cancel";

/** Register the commands. `host` gives each one the state of the session it runs in. */
export function registerShiroCommands(pi: ExtensionAPI, host: ShiroHost): void {
	pi.registerCommand("permissions", {
		description: "Show permission mode and rules, or switch mode: /permissions <mode>",
		getArgumentCompletions: (prefix) =>
			PERMISSION_MODES.filter((mode) => mode.startsWith(prefix)).map((mode) => ({
				value: mode,
				label: mode,
				description: MODE_SUMMARY[mode],
			})),
		handler: async (args, ctx) => {
			const requested = args.trim();
			if (requested === "") {
				ctx.ui.notify(formatPermissions(host.current(ctx)), "info");
				return;
			}
			const mode = PERMISSION_MODES.find((candidate) => candidate === requested);
			if (!mode) {
				ctx.ui.notify(`Unknown permission mode "${requested}". Modes: ${PERMISSION_MODES.join(", ")}.`, "error");
				return;
			}
			try {
				host.setMode(mode, ctx);
			} catch (error) {
				ctx.ui.notify((error as Error).message, "error");
				return;
			}
			ctx.ui.notify(`Permission mode: ${mode} (${MODE_SUMMARY[mode]}).`, "info");
		},
	});

	pi.registerCommand("hooks", {
		description: "List hooks, or review the ones a project brought along: /hooks trust",
		getArgumentCompletions: (prefix) =>
			["trust"].filter((word) => word.startsWith(prefix)).map((word) => ({ value: word, label: word })),
		handler: async (args, ctx) => {
			const shiro = host.current(ctx);
			if (args.trim() === "trust") await reviewHooks(shiro, ctx);
			else ctx.ui.notify(formatHooks(shiro), "info");
		},
	});

	pi.registerCommand("checkpoint", {
		description: "Mark a point files can be rewound to: /checkpoint [label]",
		handler: async (args, ctx) => {
			const checkpoint = host
				.current(ctx)
				.files.checkpoint(args.trim() || "manual checkpoint", ctx.sessionManager.getLeafId());
			ctx.ui.notify(`Checkpoint #${checkpoint.seq} taken.`, "info");
		},
	});

	pi.registerCommand("rewind", {
		description: "Put files and conversation back to a checkpoint: /rewind [number]",
		handler: async (args, ctx) => rewind(host.current(ctx), args.trim(), ctx),
	});

	pi.registerCommand("audit", {
		description: "Show recent permission decisions and the files changed this session: /audit [count]",
		handler: async (args, ctx) => {
			const count = Number.parseInt(args.trim(), 10);
			ctx.ui.notify(
				formatAudit(host.current(ctx), Number.isInteger(count) && count > 0 ? count : DEFAULT_AUDIT_COUNT),
				"info",
			);
		},
	});
}

function formatPermissions(shiro: ShiroSession): string {
	const { policy, policyConfig: config } = shiro;
	const rules = (title: string, list: readonly PermissionRule[]): string[] =>
		list.length === 0 ? [] : [`${title}:`, ...list.map((rule) => `  ${rule.text}  (${rule.source})`)];
	return [
		`Permission mode: ${policy.mode} (${MODE_SUMMARY[policy.mode]})`,
		`Workspace: ${config.workspaceRoots.join(", ")}`,
		...rules("Deny", config.deny),
		...rules("Ask", config.ask),
		...rules("Allow", config.allow),
		...rules("Allowed for this session", policy.grants),
		...(config.commandRules.length === 0 ? [] : [`Command rules: ${config.commandRules.length}`]),
		...(shiro.loadedFiles.length === 0
			? ["No policy or hook files found."]
			: ["Files read:", ...shiro.loadedFiles.map((file) => `  ${file}`)]),
		...(shiro.diagnostics.length === 0 ? [] : ["Problems:", ...shiro.diagnostics.map((problem) => `  ${problem}`)]),
		`Switch with /permissions <mode>: ${PERMISSION_MODES.join(", ")}`,
	].join("\n");
}

function formatHooks(shiro: ShiroSession): string {
	if (shiro.hookHandlers.length === 0) return "No hooks are configured.";
	const lines = shiro.hookHandlers.map((handler) => {
		const state = shiro.hookTrust.isTrusted(handler) ? handler.layer : "needs review";
		return `  [${state}] ${handler.event}${handler.matcher ? ` (${handler.matcher})` : ""}: ${handler.command}\n      ${handler.source}`;
	});
	const waiting = shiro.hookHandlers.some((handler) => !shiro.hookTrust.isTrusted(handler));
	return [
		"Hooks:",
		...lines,
		...(waiting ? ["Hooks that need review do not run. Review them with /hooks trust."] : []),
	].join("\n");
}

/** Show each unreviewed project hook and let the user approve it. A hook's command is its whole risk, so it is shown in full. */
async function reviewHooks(shiro: ShiroSession, ctx: ExtensionCommandContext): Promise<void> {
	const waiting = shiro.hookHandlers.filter((handler) => !shiro.hookTrust.isTrusted(handler));
	if (waiting.length === 0) {
		ctx.ui.notify("No hooks are waiting for review.", "info");
		return;
	}
	if (!ctx.hasUI) {
		ctx.ui.notify("Reviewing hooks needs an interactive session.", "error");
		return;
	}
	let trusted = 0;
	for (const handler of waiting) {
		const choice = await ctx.ui.select(describeHookForReview(handler), ["Trust this hook", "Skip", "Stop reviewing"]);
		if (choice === "Trust this hook") {
			shiro.hookTrust.trust(handler);
			trusted++;
		} else if (choice !== "Skip") break;
	}
	ctx.ui.notify(
		`${trusted} of ${waiting.length} hook(s) trusted. A hook whose command changes will ask for review again.`,
		"info",
	);
}

function describeHookForReview(handler: HookHandler): string {
	return [
		`Let this project hook run on ${handler.event}${handler.matcher ? ` for ${handler.matcher}` : ""}?`,
		"",
		handler.command,
		"",
		`From ${handler.source}. It runs with your permissions, outside the permission checks.`,
	].join("\n");
}

async function rewind(shiro: ShiroSession, argument: string, ctx: ExtensionCommandContext): Promise<void> {
	if (!ctx.isIdle()) {
		ctx.ui.notify("Wait for the current response to finish before rewinding.", "warning");
		return;
	}
	const checkpoints = shiro.files.checkpoints();
	if (checkpoints.length === 0) {
		ctx.ui.notify("No checkpoints yet. One is taken at every prompt.", "info");
		return;
	}
	const checkpoint = await chooseCheckpoint(checkpoints, argument, shiro, ctx);
	if (!checkpoint) return;

	const plan = shiro.files.planRewind(checkpoint.seq);
	const what = await ctx.ui.select(describePlan(checkpoint, plan), [
		FILES_AND_CONVERSATION,
		FILES_ONLY,
		CONVERSATION_ONLY,
		CANCEL,
	]);
	if (what === undefined || what === CANCEL) return;

	const summary: string[] = [];
	if (what !== CONVERSATION_ONLY) {
		const conflicts = shiro.files.findConflicts(plan);
		let force = false;
		if (conflicts.length > 0) {
			const answer = await ctx.ui.select(
				`${conflicts.length} file(s) were changed by something other than a recorded tool call:\n\n${conflicts.join("\n")}`,
				[KEEP_OUTSIDE_CHANGES, OVERWRITE_OUTSIDE_CHANGES, CANCEL],
			);
			if (answer === undefined || answer === CANCEL) return;
			force = answer === OVERWRITE_OUTSIDE_CHANGES;
		}
		const result = shiro.files.rewind(checkpoint.seq, { force });
		summary.push(`${result.restored.length} file(s) restored, ${result.deleted.length} deleted`);
		if (result.conflicts.length > 0) summary.push(`${result.conflicts.length} left as they are`);
	}
	if (what !== FILES_ONLY) {
		const target = conversationTarget(checkpoint, ctx);
		if (target === undefined)
			summary.push("the conversation was left alone (no prompt follows this checkpoint on the current branch)");
		else if ((await ctx.navigateTree(target)).cancelled) summary.push("the conversation was not moved");
		else summary.push("conversation restored");
	}
	ctx.ui.notify(`Rewound to #${checkpoint.seq}: ${summary.join("; ")}.`, "info");
}

async function chooseCheckpoint(
	checkpoints: WorkEventOf<"checkpoint">[],
	argument: string,
	shiro: ShiroSession,
	ctx: ExtensionCommandContext,
): Promise<WorkEventOf<"checkpoint"> | undefined> {
	const describe = (checkpoint: WorkEventOf<"checkpoint">): string => {
		const changed = shiro.files.planRewind(checkpoint.seq).steps.length;
		return `#${checkpoint.seq}  ${localTime(checkpoint.time)}  ${checkpoint.label}  (${changed} file(s) changed since)`;
	};
	if (argument !== "") {
		const found = checkpoints.find((checkpoint) => String(checkpoint.seq) === argument.replace(/^#/, ""));
		if (!found) ctx.ui.notify(`No checkpoint ${argument} on the current branch. Run /rewind to list them.`, "error");
		return found;
	}
	const recent = checkpoints.slice(-REWIND_PICKER_SIZE).reverse();
	if (!ctx.hasUI) {
		ctx.ui.notify(
			["Checkpoints (newest first):", ...recent.map(describe), "Rewind with /rewind <number>."].join("\n"),
			"info",
		);
		return undefined;
	}
	const labels = recent.map(describe);
	const choice = await ctx.ui.select("Rewind to which checkpoint?", labels);
	return choice === undefined ? undefined : recent[labels.indexOf(choice)];
}

function describePlan(checkpoint: WorkEventOf<"checkpoint">, plan: RewindPlan): string {
	const files = plan.steps.map(
		(step) => `  ${step.path}${step.to === null ? "  (will be deleted: it did not exist then)" : ""}`,
	);
	const commands = plan.irreversible.map((event) => `  ${event.description.split("\n", 1)[0]}`);
	return [
		`Rewind to #${checkpoint.seq} "${checkpoint.label}"?`,
		"",
		files.length === 0 ? "No recorded file changes since this checkpoint." : `Files changed since (${files.length}):`,
		...files,
		...(commands.length === 0
			? []
			: [
					"",
					`Not undone - ${commands.length} action(s) ran since whose effects are outside recorded file edits:`,
					...commands,
				]),
	].join("\n");
}

/**
 * The session entry to navigate to: the prompt that was sent right after the checkpoint. Navigating
 * to a user message puts the conversation back to just before it and returns its text to the editor.
 * Undefined when the current branch holds no prompt after the checkpoint.
 */
function conversationTarget(checkpoint: WorkEventOf<"checkpoint">, ctx: ExtensionCommandContext): string | undefined {
	const branch = ctx.sessionManager.getBranch();
	const start =
		checkpoint.sessionEntryId === null ? 0 : branch.findIndex((entry) => entry.id === checkpoint.sessionEntryId) + 1;
	// The checkpoint's entry is not on this branch: the conversation was moved elsewhere by hand, so it is left alone.
	if (checkpoint.sessionEntryId !== null && start === 0) return undefined;
	return branch.slice(start).find((entry) => entry.type === "message" && entry.message.role === "user")?.id;
}

function formatAudit(shiro: ShiroSession, count: number): string {
	const events = shiro.log.events;
	const decisions = project(events, auditTrail).slice(-count);
	const files = [...project(shiro.log.branch(), changedFiles).values()];
	const describeFile = (file: FileChangeSummary): string => {
		const change = file.before === null ? "created" : file.after === null ? "deleted" : "modified";
		return `  ${file.path}  (${change}, ${file.edits} edit(s))`;
	};
	return [
		decisions.length === 0 ? "No permission decisions yet." : `Last ${decisions.length} permission decision(s):`,
		...decisions.map(
			(event) =>
				`  ${localTime(event.time)}  ${event.outcome.padEnd(5)}  ${event.toolName}  via ${event.via} (${event.stage}): ${event.reason}`,
		),
		"",
		files.length === 0
			? "No recorded file changes on the current branch."
			: `Files changed on the current branch (${files.length}):`,
		...files.map(describeFile),
		"",
		`Work log: ${shiro.log.path}`,
	].join("\n");
}

/** The clock time of a logged event in the user's time zone; the log itself stores UTC. */
function localTime(isoTime: string): string {
	return new Date(isoTime).toLocaleTimeString(undefined, { hour12: false });
}
