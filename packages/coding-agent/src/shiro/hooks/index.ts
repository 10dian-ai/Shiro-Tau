// Public surface of the hooks layer.

export {
	DEFAULT_HOOK_TIMEOUT_SECONDS,
	HOOK_EVENTS,
	type HookEventName,
	type HookHandler,
	type HookLayer,
	type HookSources,
	hookId,
	type LoadedHooks,
	loadHooks,
	projectHookPaths,
} from "./config.ts";
export {
	type ContextOutcome,
	HookDispatcher,
	type HookDispatcherOptions,
	type HookRunRecord,
	type HookSession,
	type HookToolCall,
	type PostToolUseOutcome,
	type PreToolUseOutcome,
	type PromptOutcome,
	type StopOutcome,
} from "./dispatch.ts";
export { type HookRun, type HookRunOptions, type HookRunStatus, runHookCommand } from "./runner.ts";
export { applyUpdatedInput, hookToolInput, hookToolName } from "./tool-names.ts";
export { HookTrustStore } from "./trust.ts";
