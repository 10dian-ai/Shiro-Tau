// The Shiro runtime: every tool call passes hooks and the policy engine here, and the session is recorded in its work graph.

import { homedir } from "node:os";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import { getAgentDir } from "../config.ts";
import type {
	AgentBeforeSettleEvent,
	AgentBeforeSettleEventResult,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	InputEvent,
	InputEventResult,
	SessionShutdownEvent,
	SessionStartEvent,
	ToolCallEvent,
	ToolCallEventResult,
	ToolResultEvent,
	ToolResultEventResult,
} from "../core/extensions/types.ts";
import { resolveToCwd } from "../core/tools/path-utils.ts";
import { ApprovalGate } from "./approval.ts";
import { registerShiroCommands, type ShiroHost } from "./commands.ts";
import { boundedInput, describeToolCall, firstLine } from "./describe-call.ts";
import { canonicalPath, PERMISSION_MODES, type PermissionMode, type ToolRequest, toolKind } from "./policy/index.ts";
import { closeShiroSession, defaultManagedDir, hookSessionOf, openShiroSession, type ShiroSession } from "./session.ts";

export interface ShiroRuntimeOptions {
	/** Directory of the administrator's policy and hooks. Defaults to the system location. */
	managedDir?: string;
	/** The user's agent directory. Defaults to the configured one. */
	agentDir?: string;
	/** The user's home directory. Defaults to the operating system's. */
	home?: string;
}

/** A stop hook may keep the agent working this many times in a row before it is allowed to stop anyway. */
const MAX_STOP_CONTINUATIONS = 5;

/** Characters of a tool result kept in the work log. */
const RESULT_PREVIEW_LIMIT = 400;

const HOOK_CONTEXT_TYPE = "shiro-hook-context";
const STOP_HOOK_TYPE = "shiro-stop-hook";

/** What hooks are told about why a session started; the names are the ones hook matchers were written for. */
const SESSION_START_SOURCE: Record<SessionStartEvent["reason"], string> = {
	startup: "startup",
	reload: "startup",
	new: "clear",
	resume: "resume",
	fork: "resume",
};

const SESSION_END_REASON: Record<SessionShutdownEvent["reason"], string> = {
	quit: "exit",
	reload: "other",
	new: "clear",
	resume: "resume",
	fork: "other",
};

/**
 * Create the runtime. It is not an optional add-on: the CLI always loads it, and it runs after
 * every other extension so it judges the tool input that will really be used.
 */
export function createShiroRuntime(options: ShiroRuntimeOptions = {}): ExtensionFactory {
	return (pi) => {
		const runtime = new ShiroRuntime(pi, options);
		pi.registerFlag("permission-mode", {
			type: "string",
			description: `How much may run without asking: ${PERMISSION_MODES.join(", ")}`,
		});
		pi.on("session_start", (event, ctx) => runtime.onSessionStart(event, ctx));
		pi.on("session_shutdown", (event, ctx) => runtime.onSessionShutdown(event, ctx));
		pi.on("input", (event, ctx) => runtime.onInput(event, ctx));
		pi.on("before_agent_start", () => runtime.onBeforeAgentStart());
		pi.on("tool_call", (event, ctx) => runtime.onToolCall(event, ctx));
		pi.on("tool_result", (event, ctx) => runtime.onToolResult(event, ctx));
		pi.on("agent_before_settle", (event, ctx) => runtime.onBeforeSettle(event, ctx));
		registerShiroCommands(pi, runtime);
	};
}

class ShiroRuntime implements ShiroHost {
	private readonly pi: ExtensionAPI;
	private readonly agentDir: string;
	private readonly managedDir: string;
	private readonly home: string;
	private readonly gate = new ApprovalGate();
	private session: ShiroSession | undefined;
	/** The mode from the command line or /permissions; undefined until the flags were read or when none was given. */
	private mode: PermissionMode | undefined;
	private flagProblem: string | undefined;
	private flagsRead = false;
	/** Context from hooks that the model has not seen yet; it goes out with the next run. */
	private pendingContext: string[] = [];
	/** Context a PreToolUse hook attached to a call; it goes out with that call's result. */
	private readonly callContext = new Map<string, string[]>();
	private stopContinuations = 0;

	constructor(pi: ExtensionAPI, options: ShiroRuntimeOptions) {
		this.pi = pi;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.managedDir = options.managedDir ?? defaultManagedDir();
		this.home = options.home ?? homedir();
	}

	current(ctx: ExtensionContext): ShiroSession {
		if (this.session?.sessionId === ctx.sessionManager.getSessionId()) return this.session;
		if (this.session) closeShiroSession(this.session);
		this.readFlags();
		this.session = openShiroSession(ctx, {
			agentDir: this.agentDir,
			managedDir: this.managedDir,
			home: this.home,
			mode: this.mode,
		});
		if (this.flagProblem) this.session.diagnostics.unshift(this.flagProblem);
		this.pendingContext = [];
		this.callContext.clear();
		this.stopContinuations = 0;
		return this.session;
	}

	setMode(mode: PermissionMode, ctx: ExtensionContext): void {
		const shiro = this.current(ctx);
		shiro.policy.setMode(mode);
		this.mode = mode;
		showMode(shiro, ctx);
	}

	async onSessionStart(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		const shiro = this.current(ctx);
		shiro.log.append({ type: "session.start", reason: event.reason });
		for (const problem of shiro.diagnostics) report(ctx, problem, "warning");
		const unreviewed = shiro.hookHandlers.filter((handler) => !shiro.hookTrust.isTrusted(handler)).length;
		if (unreviewed > 0) {
			report(
				ctx,
				`${unreviewed} project hook(s) have not been reviewed and will not run. Review them with /hooks trust.`,
				"warning",
			);
		}
		showMode(shiro, ctx);
		const started = await shiro.hooks.sessionStart(SESSION_START_SOURCE[event.reason], hookSessionOf(shiro, ctx));
		this.pendingContext.push(...started.additionalContext);
	}

	async onSessionShutdown(event: SessionShutdownEvent, ctx: ExtensionContext): Promise<void> {
		const shiro = this.session;
		if (!shiro) return;
		this.session = undefined;
		try {
			await shiro.hooks.sessionEnd(SESSION_END_REASON[event.reason], hookSessionOf(shiro, ctx));
		} finally {
			closeShiroSession(shiro);
		}
	}

	/** A prompt arrived: let hooks refuse it or add context, then mark the point files can be rewound to. */
	async onInput(event: InputEvent, ctx: ExtensionContext): Promise<InputEventResult> {
		const shiro = this.current(ctx);
		// Text another extension sent is not something the user typed, so prompt hooks do not see it.
		if (event.source !== "extension" && shiro.hooks.has("UserPromptSubmit")) {
			const outcome = await shiro.hooks.userPromptSubmit(event.text, hookSessionOf(shiro, ctx));
			if (outcome.blocked !== undefined) {
				report(ctx, `A hook refused this prompt: ${outcome.blocked}`, "warning");
				return { action: "handled" };
			}
			this.deliverContext(outcome.additionalContext, event.streamingBehavior);
		}
		shiro.log.append({ type: "user.message", text: event.text });
		shiro.files.checkpoint(firstLine(event.text, 60), ctx.sessionManager.getLeafId());
		this.stopContinuations = 0;
		return { action: "continue" };
	}

	onBeforeAgentStart(): BeforeAgentStartEventResult | undefined {
		if (this.pendingContext.length === 0) return undefined;
		const content = this.pendingContext.splice(0).join("\n\n");
		return { message: { customType: HOOK_CONTEXT_TYPE, content, display: false } };
	}

	/**
	 * The gate every tool call passes: hooks first, then the policy engine, then the user when the
	 * engine says to ask. Anything thrown here blocks the call, so a fault never lets one through.
	 */
	async onToolCall(event: ToolCallEvent, ctx: ExtensionContext): Promise<ToolCallEventResult | undefined> {
		const shiro = this.current(ctx);
		const { toolName, toolCallId } = event;
		// Every variant of the event carries a plain object as input; the union only narrows its fields.
		const input = event.input as Record<string, unknown>;
		shiro.log.append({
			type: "tool.call",
			toolCallId,
			toolName,
			input: boundedInput(input),
			...(event.parentToolCallId ? { parentToolCallId: event.parentToolCallId } : {}),
		});

		let hookPermission: "allow" | "ask" | undefined;
		if (shiro.hooks.has("PreToolUse")) {
			const outcome = await shiro.hooks.preToolUse({ toolName, toolCallId, input }, hookSessionOf(shiro, ctx));
			if (outcome.blocked !== undefined) {
				shiro.log.append({
					type: "policy.decision",
					toolCallId,
					toolName,
					outcome: "deny",
					via: "hook",
					stage: "hook",
					reason: outcome.blocked,
					mode: shiro.policy.mode,
				});
				return { block: true, reason: `Blocked by a hook: ${outcome.blocked}` };
			}
			if (outcome.updatedInput) {
				// The tool reads the same object, so it is rewritten in place.
				for (const key of Object.keys(input)) delete input[key];
				Object.assign(input, outcome.updatedInput);
			}
			if (outcome.additionalContext.length > 0) this.callContext.set(toolCallId, outcome.additionalContext);
			hookPermission = outcome.permission;
		}

		const request = policyRequest(toolName, input, shiro, ctx);
		const settlement = await this.gate.settle(shiro, request, describeToolCall(toolName, input), hookPermission, ctx);
		const { decision } = settlement;
		shiro.log.append({
			type: "policy.decision",
			toolCallId,
			toolName,
			outcome: settlement.outcome,
			via: settlement.via,
			stage: decision.stage,
			reason: decision.reason,
			mode: shiro.policy.mode,
			...(decision.rule === undefined ? {} : { rule: decision.rule }),
		});
		if (settlement.outcome === "deny") {
			this.callContext.delete(toolCallId);
			// When the user says no, the agent stops and waits instead of trying another route to the same end.
			return settlement.via === "user"
				? {
						block: true,
						reason: "The user declined this tool call. Stop and wait for their instructions.",
						terminate: true,
					}
				: { block: true, reason: `Blocked by the permission policy: ${decision.reason}.` };
		}

		const kind = toolKind(toolName);
		if (kind === "edit" && typeof request.input.path === "string") {
			shiro.files.captureBefore(toolCallId, canonicalPath(request.input.path));
		} else if (kind !== "read" && !shiro.policy.onlyReads(request)) {
			shiro.log.append({
				type: "irreversible",
				toolCallId,
				kind: "command",
				description: describeToolCall(toolName, input),
			});
		}
		return undefined;
	}

	/** A tool finished: record what it changed, then let hooks comment on the result. */
	async onToolResult(event: ToolResultEvent, ctx: ExtensionContext): Promise<ToolResultEventResult | undefined> {
		const shiro = this.current(ctx);
		const { toolName, toolCallId } = event;
		const text = textOf(event.content);
		shiro.files.recordAfter(toolCallId);
		shiro.log.append({
			type: "tool.result",
			toolCallId,
			toolName,
			isError: event.isError,
			preview: text.length > RESULT_PREVIEW_LIMIT ? `${text.slice(0, RESULT_PREVIEW_LIMIT)}…` : text,
		});

		const notes = this.callContext.get(toolCallId) ?? [];
		this.callContext.delete(toolCallId);
		if (shiro.hooks.has("PostToolUse")) {
			const outcome = await shiro.hooks.postToolUse(
				{ toolName, toolCallId, input: event.input },
				{ text, is_error: event.isError },
				hookSessionOf(shiro, ctx),
			);
			notes.push(...outcome.feedback.map((feedback) => `A hook reports a problem with this result: ${feedback}`));
			notes.push(...outcome.additionalContext);
		}
		if (notes.length === 0) return undefined;
		return {
			content: [...event.content, { type: "text", text: notes.join("\n\n") }],
			// Replacing content alone would drop the structured result, which is unchanged here.
			...(event.structuredContent === undefined ? {} : { structuredContent: event.structuredContent }),
		};
	}

	/** The agent is about to stop: a Stop hook may say the work is not done and send it back. */
	async onBeforeSettle(
		event: AgentBeforeSettleEvent,
		ctx: ExtensionContext,
	): Promise<AgentBeforeSettleEventResult | undefined> {
		const shiro = this.current(ctx);
		if (event.outcome !== "completed" || event.continue || !shiro.hooks.has("Stop")) return undefined;
		if (this.stopContinuations >= MAX_STOP_CONTINUATIONS) {
			report(
				ctx,
				`Stop hooks sent the agent back ${MAX_STOP_CONTINUATIONS} times in a row; it is allowed to stop now.`,
				"warning",
			);
			return undefined;
		}
		const outcome = await shiro.hooks.stop(this.stopContinuations > 0, hookSessionOf(shiro, ctx));
		if (outcome.continueWith === undefined) return undefined;
		this.stopContinuations++;
		const content = `A stop hook says the work is not finished:\n\n${outcome.continueWith}`;
		return {
			entries: [...event.entries, { type: "custom_message", customType: STOP_HOOK_TYPE, content, display: true }],
			continue: true,
		};
	}

	private readFlags(): void {
		if (this.flagsRead) return;
		this.flagsRead = true;
		const requested = this.pi.getFlag("permission-mode");
		if (typeof requested !== "string") return;
		const mode = PERMISSION_MODES.find((candidate) => candidate === requested);
		if (mode) this.mode = mode;
		else this.flagProblem = `Unknown permission mode "${requested}". Use one of: ${PERMISSION_MODES.join(", ")}.`;
	}

	/** Hand hook context to the model: with the next run when idle, or alongside a prompt queued during a run. */
	private deliverContext(context: string[], streamingBehavior: InputEvent["streamingBehavior"]): void {
		if (context.length === 0) return;
		if (!streamingBehavior) {
			this.pendingContext.push(...context);
			return;
		}
		this.pi.sendMessage(
			{ customType: HOOK_CONTEXT_TYPE, content: context.join("\n\n"), display: false },
			{ deliverAs: streamingBehavior },
		);
	}
}

/**
 * The call as the policy engine should judge it. The file tools resolve paths their own way (home
 * directory, "@" prefix, unusual spaces), so the engine is given the path they will really touch.
 */
function policyRequest(
	toolName: string,
	input: Record<string, unknown>,
	shiro: ShiroSession,
	ctx: ExtensionContext,
): ToolRequest {
	const kind = toolKind(toolName);
	const path =
		(kind === "read" || kind === "edit") && typeof input.path === "string"
			? resolveToCwd(input.path, ctx.cwd)
			: undefined;
	return { toolName, input: path === undefined ? input : { ...input, path }, cwd: shiro.cwd };
}

function showMode(shiro: ShiroSession, ctx: ExtensionContext): void {
	ctx.ui.setStatus(
		"shiro-permissions",
		shiro.policy.mode === "default" ? undefined : `permissions: ${shiro.policy.mode}`,
	);
}

/** Tell the user something. Without a UI, notifications go nowhere, so the message is written to stderr. */
export function report(ctx: ExtensionContext, message: string, level: "info" | "warning" | "error"): void {
	if (ctx.hasUI) ctx.ui.notify(message, level);
	else console.error(message);
}

function textOf(content: readonly (TextContent | ImageContent)[]): string {
	return content.map((part) => (part.type === "text" ? part.text : "[image]")).join("\n");
}
