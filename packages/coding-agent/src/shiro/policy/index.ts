// Public surface of the policy engine.

export { canonicalPath } from "./canonical-path.ts";
export {
	type CommandDecision,
	matchPrefixRules,
	type ParsedRulesFile,
	type PrefixRule,
	parseRulesFile,
} from "./command-rules.ts";
export { type LoadedPolicy, loadPolicy, type PolicySources, projectPolicyPaths } from "./config.ts";
export {
	type Decision,
	type DecisionStage,
	PERMISSION_MODES,
	type PermissionMode,
	type PolicyConfig,
	PolicyEngine,
	type ToolRequest,
} from "./engine.ts";
export {
	commandSpecMatches,
	type PathContext,
	type PermissionRule,
	parsePermissionRule,
	pathSpecMatches,
	requestPath,
	ruleCoversTool,
	type ToolKind,
	toolKind,
} from "./permission-rules.ts";
export { isInsideRoots, isReadOnlyCommand } from "./read-only.ts";
export { looseCommands, type ParsedShell, parseShell, type SimpleCommand } from "./shell.ts";
