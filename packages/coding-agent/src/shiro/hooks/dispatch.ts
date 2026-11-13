// Runs the hooks registered for a lifecycle event and folds their answers into one outcome.

import type { HookEventName, HookHandler } from "./config.ts";
import { type HookRun, type HookRunStatus, runHookCommand } from "./runner.ts";
import { applyUpdatedInput, hookToolInput, hookToolName } from "./tool-names.ts";
import type { HookTrustStore } from "./trust.ts";

/** Session facts every hook receives. */
export interface HookSession {
	sessionId: string;
	/** The session file, when the session is saved to disk. */
	transcriptPath: string | undefined;
	cwd: string;
	/** Exposed to hooks as SHIRO_PROJECT_DIR and CLAUDE_PROJECT_DIR. */
	projectDir: string;
	permissionMode: string;
}

export interface HookToolCall {
	toolName: string;
	toolCallId: string;
	input: Record<string, unknown>;
}

/** One hook that ran, or was skipped because nobody reviewed it yet. */
export interface HookRunRecord {
	handler: HookHandler;
	status: HookRunStatus | "untrusted";
	exitCode: number | null;
	durationMs: number;
	stderr: string;
}

export interface PreToolUseOutcome {
	/** Set when a hook refused the call: the reason to show the model. A refusal beats every other answer. */
	blocked?: string;
	/** What hooks asked the policy engine to do. "ask" beats "allow". */
	permission?: "allow" | "ask";
	/** The rewritten tool input, in the tool's own field names. */
	updatedInput?: Record<string, unknown>;
	additionalContext: string[];
}

export interface PostToolUseOutcome {
	/** Messages for the model about the result it just got, e.g. a failed lint run. */
	feedback: string[];
	additionalContext: string[];
}

export interface PromptOutcome {
	/** Set when a hook refused the prompt: the reason to show the user. */
	blocked?: string;
	additionalContext: string[];
}

export interface StopOutcome {
	/** Set when a hook wants the agent to keep working: the instruction to continue with. */
	continueWith?: string;
}

export interface ContextOutcome {
	additionalContext: string[];
}

export interface HookDispatcherOptions {
	handlers: readonly HookHandler[];
	trust: HookTrustStore;
	/** Environment for hook processes, before the project directory variables are added. */
	env: NodeJS.ProcessEnv;
	/** Called for every run and every skip, in handler order, for the work log. */
	onRun: (record: HookRunRecord) => void;
}

/** Dispatches lifecycle events to command hooks. Hooks for one event run concurrently. */
export class HookDispatcher {
	private readonly options: HookDispatcherOptions;

	constructor(options: HookDispatcherOptions) {
		this.options = options;
	}

	/** Whether any hook is registered for the event, trusted or not. */
	has(event: HookEventName): boolean {
		return this.options.handlers.some((handler) => handler.event === event);
	}

	/** Before a tool runs. Hooks may refuse the call, answer the permission question or rewrite the input. */
	async preToolUse(call: HookToolCall, session: HookSession): Promise<PreToolUseOutcome> {
		const runs = await this.run("PreToolUse", toolTargets(call.toolName), session, toolPayload(call));
		const outcome: PreToolUseOutcome = { additionalContext: collectContext(runs, false) };
		let input = call.input;
		let rewritten = false;
		for (const run of runs) {
			const specific = record(run.output?.hookSpecificOutput);
			const decision = specific?.permissionDecision;
			const refusal =
				decision === "deny"
					? text(specific?.permissionDecisionReason, `Denied by hook: ${run.handler.command}`)
					: refusalOf(run);
			if (refusal !== undefined) return { blocked: refusal, additionalContext: outcome.additionalContext };
			if (decision === "ask") outcome.permission = "ask";
			else if ((decision === "allow" || run.output?.decision === "approve") && outcome.permission !== "ask") {
				outcome.permission = "allow";
			}
			const updated = record(specific?.updatedInput);
			if (updated) {
				input = applyUpdatedInput(input, updated);
				rewritten = true;
			}
		}
		if (rewritten) outcome.updatedInput = input;
		return outcome;
	}

	/** After a tool ran. Hooks cannot undo it; they can tell the model what is wrong with the result. */
	async postToolUse(call: HookToolCall, response: unknown, session: HookSession): Promise<PostToolUseOutcome> {
		const runs = await this.run("PostToolUse", toolTargets(call.toolName), session, {
			...toolPayload(call),
			tool_response: response,
		});
		const feedback = runs.map(refusalOf).filter((reason) => reason !== undefined);
		return { feedback, additionalContext: collectContext(runs, false) };
	}

	/** When the user sends a prompt. Hooks may refuse it or add context; plain output counts as context. */
	async userPromptSubmit(prompt: string, session: HookSession): Promise<PromptOutcome> {
		const runs = await this.run("UserPromptSubmit", [], session, { prompt });
		const blocked = runs.map(refusalOf).find((reason) => reason !== undefined);
		return { ...(blocked === undefined ? {} : { blocked }), additionalContext: collectContext(runs, true) };
	}

	/** When the agent is about to stop. A refusal means "not done yet": its reason becomes the next instruction. */
	async stop(stopHookActive: boolean, session: HookSession): Promise<StopOutcome> {
		const runs = await this.run("Stop", [], session, { stop_hook_active: stopHookActive });
		const reasons = runs.map(refusalOf).filter((reason) => reason !== undefined);
		return reasons.length > 0 ? { continueWith: reasons.join("\n\n") } : {};
	}

	/** When a session starts or resumes. Plain output counts as context for the model. */
	async sessionStart(source: string, session: HookSession): Promise<ContextOutcome> {
		const runs = await this.run("SessionStart", [source], session, { source });
		return { additionalContext: collectContext(runs, true) };
	}

	/** When a session ends. Hooks only observe. */
	async sessionEnd(reason: string, session: HookSession): Promise<void> {
		await this.run("SessionEnd", [reason], session, { reason });
	}

	/** Run every trusted hook for the event whose matcher accepts one of `targets`; results keep handler order. */
	private async run(
		event: HookEventName,
		targets: readonly string[],
		session: HookSession,
		fields: Record<string, unknown>,
	): Promise<HookRun[]> {
		const { handlers, trust, onRun } = this.options;
		const matching = handlers.filter((handler) => handler.event === event && matches(handler, targets));
		if (matching.length === 0) return [];
		const payload = {
			session_id: session.sessionId,
			transcript_path: session.transcriptPath ?? null,
			cwd: session.cwd,
			hook_event_name: event,
			permission_mode: session.permissionMode,
			...fields,
		};
		const env = {
			...this.options.env,
			SHIRO_PROJECT_DIR: session.projectDir,
			CLAUDE_PROJECT_DIR: session.projectDir,
		};
		const settled = await Promise.all(
			matching.map((handler) =>
				trust.isTrusted(handler) ? runHookCommand(handler, payload, { cwd: session.cwd, env }) : handler,
			),
		);
		const runs: HookRun[] = [];
		for (const result of settled) {
			if ("status" in result) {
				runs.push(result);
				onRun({ ...result, stderr: result.stderr.trim() });
			} else {
				onRun({ handler: result, status: "untrusted", exitCode: null, durationMs: 0, stderr: "" });
			}
		}
		return runs;
	}
}

/** A tool is matched under the name hooks know it by and under its own. */
function toolTargets(toolName: string): string[] {
	return [...new Set([hookToolName(toolName), toolName])];
}

function toolPayload(call: HookToolCall): Record<string, unknown> {
	return {
		tool_name: hookToolName(call.toolName),
		tool_use_id: call.toolCallId,
		tool_input: hookToolInput(call.input),
	};
}

function matches(handler: HookHandler, targets: readonly string[]): boolean {
	if (handler.matcher === undefined || targets.length === 0) return true;
	// The matcher was checked to compile when the file was loaded.
	const pattern = new RegExp(`^(?:${handler.matcher})$`);
	return targets.some((target) => pattern.test(target));
}

/**
 * Why a hook refused, or undefined when it did not: exit code 2 (reason on stderr),
 * `{"decision": "block"}` or `{"continue": false}`.
 */
function refusalOf(run: HookRun): string | undefined {
	if (run.status === "blocked") return run.stderr.trim() || `Blocked by hook: ${run.handler.command}`;
	if (run.output?.decision === "block") return text(run.output.reason, `Blocked by hook: ${run.handler.command}`);
	if (run.output?.continue === false) return text(run.output.stopReason, `Stopped by hook: ${run.handler.command}`);
	return undefined;
}

/** Context hooks want the model to see. `plainOutput` says whether non-JSON stdout counts, which depends on the event. */
function collectContext(runs: readonly HookRun[], plainOutput: boolean): string[] {
	const context: string[] = [];
	for (const run of runs) {
		if (run.status !== "ok") continue;
		const specific = record(run.output?.hookSpecificOutput);
		const additional = specific?.additionalContext ?? run.output?.additionalContext;
		if (typeof additional === "string" && additional.trim() !== "") context.push(additional.trim());
		else if (plainOutput && !run.output && run.stdout.trim() !== "") context.push(run.stdout.trim());
	}
	return context;
}

// Hook output is untrusted JSON: these two read a field only when it has the expected type.
function record(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

function text(value: unknown, fallback: string): string {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : fallback;
}
