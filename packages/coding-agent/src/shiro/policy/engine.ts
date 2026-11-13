// The policy engine: one decision pipeline that every tool call goes through before it runs.

import { basename, dirname, relative, resolve, sep } from "node:path";
import { canonicalPath } from "./canonical-path.ts";
import { matchPrefixRules, type PrefixRule } from "./command-rules.ts";
import {
	commandSpecMatches,
	type PathContext,
	type PermissionRule,
	parsePermissionRule,
	pathSpecMatches,
	requestPath,
	ruleCoversTool,
	toolKind,
} from "./permission-rules.ts";
import { isInsideRoots, isReadOnlyCommand } from "./read-only.ts";
import { looseCommands, type ParsedShell, parseShell, type SimpleCommand } from "./shell.ts";

/**
 * How much the agent may do without asking.
 * - `default`: reads run; edits and commands ask.
 * - `acceptEdits`: edits inside the workspace also run.
 * - `plan`: read-only; edits and commands that change things are refused.
 * - `dontAsk`: whatever would ask is refused instead, for unattended runs.
 * - `bypassPermissions`: everything not denied runs. Only for throwaway sandboxes.
 */
export type PermissionMode = "default" | "acceptEdits" | "plan" | "dontAsk" | "bypassPermissions";

export const PERMISSION_MODES: readonly PermissionMode[] = [
	"default",
	"acceptEdits",
	"plan",
	"dontAsk",
	"bypassPermissions",
];

/** The pipeline stage that settled a decision. */
export type DecisionStage =
	| "deny-rule"
	| "command-rule"
	| "plan-mode"
	| "ask-rule"
	| "hook"
	| "protected-path"
	| "boundary"
	| "allow-rule"
	| "read-only"
	| "mode";

export interface Decision {
	outcome: "allow" | "ask" | "deny";
	stage: DecisionStage;
	/** One sentence a person can read in an approval prompt or audit log. */
	reason: string;
	/** The rule that decided, as written, when one did. */
	rule?: string;
}

export interface ToolRequest {
	toolName: string;
	input: Record<string, unknown>;
	cwd: string;
}

export interface PolicyConfig {
	mode: PermissionMode;
	allow: PermissionRule[];
	ask: PermissionRule[];
	deny: PermissionRule[];
	commandRules: PrefixRule[];
	/** Directories file tools may touch without asking: the project plus any added directories. Real paths, no links. */
	workspaceRoots: string[];
	/** The directory the agent was started in; `/x` in a path rule means `x` inside it. */
	projectRoot: string;
	home: string;
	/** Set by managed policy to make `bypassPermissions` unavailable. */
	disableBypassPermissions: boolean;
	/** Tools that only route to other tools, whose calls are judged one by one (codemode, tool search). */
	passThroughTools: string[];
}

/** Directories and files whose edits always ask: they configure the agent, git or the shell. */
const PROTECTED_DIRS = [".git", ".shiro", ".pi", ".claude", ".codex"];
const PROTECTED_FILES = [".bashrc", ".bash_profile", ".zshrc", ".zprofile", ".profile", ".gitconfig", ".npmrc"];

/** Commands that run the command given in their arguments; deny and ask rules look through them. */
const WRAPPERS = [
	"sudo",
	"doas",
	"env",
	"command",
	"builtin",
	"exec",
	"nohup",
	"time",
	"nice",
	"ionice",
	"timeout",
	"stdbuf",
	"xargs",
	"find",
];
const SHELLS = ["bash", "sh", "zsh", "dash", "ksh", "fish"];

/** Stages whose "ask" an allow rule cannot lift, so no "always allow" is offered for them. */
const FIRM_ASK_STAGES: readonly DecisionStage[] = ["ask-rule", "hook", "command-rule", "protected-path"];

/** CLIs whose first argument is a subcommand; "always allow" then covers `git status`, not all of `git`. */
const SUBCOMMAND_CLIS = ["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "gh", "pip", "uv"];

/** Evaluates tool calls against one configuration plus the grants made during the session. */
export class PolicyEngine {
	private readonly config: PolicyConfig;
	private currentMode: PermissionMode;
	private readonly sessionAllow: PermissionRule[] = [];

	constructor(config: PolicyConfig) {
		this.config = config;
		this.currentMode =
			config.mode === "bypassPermissions" && config.disableBypassPermissions ? "default" : config.mode;
	}

	get mode(): PermissionMode {
		return this.currentMode;
	}

	/** Switch mode. Throws when managed policy forbids the requested one. */
	setMode(mode: PermissionMode): void {
		if (mode === "bypassPermissions" && this.config.disableBypassPermissions) {
			throw new Error("bypassPermissions is disabled by managed policy");
		}
		this.currentMode = mode;
	}

	/** Allow matching calls for the rest of the session. Deny rules still win. */
	grant(rule: PermissionRule): void {
		this.sessionAllow.push(rule);
	}

	/** Rules granted during this session, oldest first. */
	get grants(): readonly PermissionRule[] {
		return this.sessionAllow;
	}

	/**
	 * Decide one tool call. `hookPermission` is what PreToolUse hooks asked for: "allow" skips the
	 * prompt but never overrides a deny, a forbidden command, plan mode or a protected path.
	 */
	evaluate(request: ToolRequest, hookPermission?: "allow" | "ask"): Decision {
		const decision = this.decide(request, hookPermission);
		if (decision.outcome === "ask" && this.currentMode === "dontAsk") {
			return { ...decision, outcome: "deny", reason: `${decision.reason} (dontAsk mode refuses instead of asking)` };
		}
		return decision;
	}

	/**
	 * Whether the call is known to change nothing: a read tool, or a command line made only of
	 * read-only commands that stay inside the workspace. Everything else may have effects a file
	 * rewind cannot undo.
	 */
	onlyReads(request: ToolRequest): boolean {
		if (toolKind(request.toolName) === "read") return true;
		const shell = this.parseCommand(request);
		return (
			shell?.kind === "simple" &&
			shell.commands.length > 0 &&
			shell.commands.every((command) =>
				isReadOnlyCommand(command, request.cwd, this.config.home, this.config.workspaceRoots),
			)
		);
	}

	/**
	 * A rule that would allow calls like this one, for an "always allow" choice next to the prompt
	 * `decision` describes. Undefined when no rule could lift that prompt or none is narrow enough.
	 */
	suggestGrant(request: ToolRequest, decision: Decision): PermissionRule | undefined {
		if (decision.outcome !== "ask" || FIRM_ASK_STAGES.includes(decision.stage)) return undefined;
		const kind = toolKind(request.toolName);
		if (kind === "read" || kind === "edit") {
			const family = kind === "read" ? "Read" : "Edit";
			if (decision.stage !== "boundary")
				return kind === "edit" ? parsePermissionRule("Edit(/**)", "session") : undefined;
			// Outside the workspace: offer the file's directory, never a wider tree.
			const directory = dirname(canonicalPath(requestPath(request.input, request.cwd, this.config.home)));
			if (/[*?]/.test(directory) || directory === sep) return undefined;
			return parsePermissionRule(`${family}(/${directory}/**)`, "session");
		}
		if (kind === "other") return parsePermissionRule(request.toolName, "session");
		const shell = this.parseCommand(request);
		// A prompt about where a command writes is not lifted by allowing the command.
		if (decision.stage !== "mode" || shell?.kind !== "simple" || shell.commands.length !== 1) return undefined;
		const [name, second] = shell.commands[0].argv;
		if (WRAPPERS.includes(name) || SHELLS.includes(name) || name === "eval") return undefined;
		const withSubcommand = SUBCOMMAND_CLIS.includes(name) && second !== undefined && /^[a-z][\w-]*$/.test(second);
		return parsePermissionRule(`Bash(${withSubcommand ? `${name} ${second}` : name}:*)`, "session");
	}

	private decide(request: ToolRequest, hookPermission: "allow" | "ask" | undefined): Decision {
		const { config } = this;
		const mode = this.currentMode;
		const kind = toolKind(request.toolName);
		const context: PathContext = { cwd: request.cwd, projectRoot: config.projectRoot, home: config.home };
		const shell = this.parseCommand(request);
		const commands = shell?.kind === "simple" ? shell.commands : [];
		// Links are resolved first, so a link inside the workspace cannot stand in for a file outside it.
		const path =
			kind === "read" || kind === "edit"
				? canonicalPath(requestPath(request.input, request.cwd, config.home))
				: undefined;
		const redirects = commands
			.flatMap((command) => command.writeTargets)
			.map((target) => redirectPath(target, request.cwd, config.home));
		const strict = shell ? strictCandidates(commandOf(request), shell) : [];
		const matchAny = (rules: readonly PermissionRule[]): PermissionRule | undefined =>
			rules.find((rule) => this.ruleMatchesAny(rule, request, strict, path, context));

		// Files a command line names, as real paths. File rules cover them too, so a denied file
		// cannot be reached by handing its name to a shell command instead of a file tool.
		const named = shell ? namedPaths(strict, request.cwd, config.home) : [];
		// What a command may write: the files it redirects into and, unless it only reads, every file it names.
		const commandWrites = shell && !this.onlyReads(request) ? [...redirects, ...named] : redirects;
		const denied =
			matchAny(config.deny) ??
			fileRuleFor(config.deny, "read", named, context) ??
			fileRuleFor(config.deny, "edit", commandWrites, context);
		if (denied)
			return { outcome: "deny", stage: "deny-rule", reason: `Denied by rule ${denied.text}`, rule: denied.text };

		const commandRules = strict.map((argv) => matchPrefixRules(config.commandRules, argv));
		const forbidden = commandRules.find((rule) => rule?.decision === "forbidden");
		if (forbidden) {
			return {
				outcome: "deny",
				stage: "command-rule",
				reason: forbidden.justification ?? `Forbidden by command rule at ${forbidden.source}`,
				rule: forbidden.source,
			};
		}

		if (mode === "plan" && (kind === "edit" || (kind === "execute" && !this.onlyReads(request)))) {
			return {
				outcome: "deny",
				stage: "plan-mode",
				reason: "Plan mode is read-only: propose the change instead of making it",
			};
		}

		const asked = matchAny(config.ask);
		if (asked)
			return { outcome: "ask", stage: "ask-rule", reason: `Rule ${asked.text} asks first`, rule: asked.text };
		if (hookPermission === "ask") return { outcome: "ask", stage: "hook", reason: "A hook asked for confirmation" };
		const prompt = commandRules.find((rule) => rule?.decision === "prompt");
		if (prompt) {
			return {
				outcome: "ask",
				stage: "command-rule",
				reason: prompt.justification ?? `Command rule at ${prompt.source} asks first`,
				rule: prompt.source,
			};
		}

		const allowRules = [...config.allow, ...this.sessionAllow];
		if (mode !== "bypassPermissions") {
			const written = kind === "edit" && path !== undefined ? [path] : commandWrites;
			const guarded = written.find((target) => target !== undefined && isProtectedPath(target, config.projectRoot));
			if (guarded !== undefined) {
				return {
					outcome: "ask",
					stage: "protected-path",
					reason: `${guarded} configures the agent, git or your shell`,
				};
			}
			if (redirects.includes(undefined)) {
				return {
					outcome: "ask",
					stage: "boundary",
					reason: "The command writes to a path that cannot be checked before it runs",
				};
			}
			const outside = redirects.find(
				(target) => target !== undefined && !isInsideRoots(target, config.workspaceRoots),
			);
			if (outside !== undefined) {
				return {
					outcome: "ask",
					stage: "boundary",
					reason: `The command writes to ${outside}, outside the workspace`,
				};
			}
			if (path !== undefined && !isInsideRoots(path, config.workspaceRoots)) {
				const explicit = allowRules.find(
					(rule) => rule.spec !== undefined && this.ruleMatchesAny(rule, request, strict, path, context),
				);
				if (!explicit) return { outcome: "ask", stage: "boundary", reason: `${path} is outside the workspace` };
				return {
					outcome: "allow",
					stage: "allow-rule",
					reason: `Allowed by rule ${explicit.text}`,
					rule: explicit.text,
				};
			}
		}

		if (hookPermission === "allow") return { outcome: "allow", stage: "hook", reason: "A hook approved this call" };
		if (config.passThroughTools.includes(request.toolName)) {
			return { outcome: "allow", stage: "mode", reason: "Routes to other tools, which are checked one by one" };
		}
		if (shell?.kind === "simple" && commands.length > 0) {
			const allowedBy = commands.map((command) => this.commandAllowance(command, request, allowRules, context));
			if (allowedBy.every((entry) => entry !== undefined)) {
				const rule = allowedBy.find((entry) => entry !== "read-only");
				return rule
					? { outcome: "allow", stage: "allow-rule", reason: `Allowed by rule ${rule}`, rule }
					: { outcome: "allow", stage: "read-only", reason: "Read-only command" };
			}
		} else {
			// A line the parser cannot follow is only covered by a rule for the whole tool (`Bash`), never by a pattern.
			const allowed = allowRules.find(
				(rule) =>
					(shell ? rule.spec === undefined : true) && this.ruleMatchesAny(rule, request, strict, path, context),
			);
			if (allowed)
				return {
					outcome: "allow",
					stage: "allow-rule",
					reason: `Allowed by rule ${allowed.text}`,
					rule: allowed.text,
				};
		}

		if (mode === "bypassPermissions") return { outcome: "allow", stage: "mode", reason: "bypassPermissions mode" };
		if (kind === "read")
			return { outcome: "allow", stage: "mode", reason: "Reads inside the workspace need no approval" };
		if (kind === "edit" && mode === "acceptEdits") {
			return { outcome: "allow", stage: "mode", reason: "acceptEdits mode allows edits inside the workspace" };
		}
		if (shell?.kind === "complex") {
			return { outcome: "ask", stage: "mode", reason: `The command uses ${shell.reason}, which rules cannot check` };
		}
		return { outcome: "ask", stage: "mode", reason: ASK_REASON[kind] };
	}

	private parseCommand(request: ToolRequest): ParsedShell | undefined {
		if (toolKind(request.toolName) !== "execute") return undefined;
		// The parser follows POSIX shell syntax only; other shells are never auto-allowed by pattern.
		return request.toolName === "bash"
			? parseShell(commandOf(request))
			: { kind: "complex", reason: "a shell other than bash" };
	}

	/**
	 * Whether a rule applies to the call. For shells a rule applies when any command the line might
	 * run matches it, which is the right test for deny and ask rules.
	 */
	private ruleMatchesAny(
		rule: PermissionRule,
		request: ToolRequest,
		strict: readonly string[][],
		path: string | undefined,
		context: PathContext,
	): boolean {
		if (!ruleCoversTool(rule, request.toolName)) return false;
		if (rule.spec === undefined) return true;
		const spec = rule.spec;
		if (toolKind(request.toolName) === "execute") {
			return (
				commandSpecMatches(spec, commandOf(request).trim()) ||
				strict.some((argv) => commandSpecMatches(spec, argv.join(" ")))
			);
		}
		return path !== undefined && pathSpecMatches(spec, path, context);
	}

	/** Why one command may run without asking: an allow rule's text, "read-only", or undefined when nothing allows it. */
	private commandAllowance(
		command: SimpleCommand,
		request: ToolRequest,
		allowRules: readonly PermissionRule[],
		context: PathContext,
	): string | undefined {
		const text = command.argv.join(" ");
		const rule = allowRules.find(
			(candidate) =>
				ruleCoversTool(candidate, request.toolName) &&
				(candidate.spec === undefined || commandSpecMatches(candidate.spec, text)),
		);
		if (rule) return rule.text;
		const prefixRule = matchPrefixRules(this.config.commandRules, command.argv);
		if (prefixRule?.decision === "allow") return prefixRule.source;
		return isReadOnlyCommand(command, context.cwd, context.home, this.config.workspaceRoots)
			? "read-only"
			: undefined;
	}
}

const ASK_REASON = {
	read: "Reading needs approval",
	edit: "Editing files needs approval in this mode",
	execute: "Running this command needs approval",
	other: "This tool needs approval",
} as const;

function commandOf(request: ToolRequest): string {
	return typeof request.input.command === "string" ? request.input.command : "";
}

/**
 * Every command the line might run, over-reported: each parsed command, plus what it hands to a
 * wrapper (`sudo x`, `xargs x`) or a nested shell (`sh -c "x"`). Only used to tighten.
 */
function strictCandidates(source: string, shell: ParsedShell): string[][] {
	const direct = shell.kind === "simple" ? shell.commands.map((command) => command.argv) : looseCommands(source);
	return direct.flatMap((argv) => withWrapped(argv, 0));
}

function withWrapped(argv: string[], depth: number): string[][] {
	const found = [argv];
	// Nesting deeper than this is not something a person types; the line then asks like any unknown command.
	if (depth >= 3) return found;
	const [name, ...rest] = argv;
	if (WRAPPERS.includes(name)) {
		// The wrapped command starts somewhere after the wrapper's own options, so every suffix is a candidate.
		for (let start = 0; start < rest.length; start++) found.push(...withWrapped(rest.slice(start), depth + 1));
	} else if (SHELLS.includes(name) || name === "eval") {
		const flag = rest.findIndex((arg) => /^-[A-Za-z]*c$/.test(arg));
		const script = name === "eval" ? rest.join(" ") : flag === -1 ? undefined : rest[flag + 1];
		if (script !== undefined) {
			const parsed = parseShell(script);
			const inner =
				parsed.kind === "simple" ? parsed.commands.map((command) => command.argv) : looseCommands(script);
			for (const command of inner) found.push(...withWrapped(command, depth + 1));
		}
	}
	return found;
}

/**
 * Every word of the candidate commands that could name a file, as a real path: arguments, and the
 * value of `--option=value`. Words that are plain options or mention a variable are left out.
 */
function namedPaths(strict: readonly string[][], cwd: string, home: string): string[] {
	const paths = new Set<string>();
	for (const argv of strict) {
		for (const word of argv.slice(1)) {
			const value = word.startsWith("-") ? (word.includes("=") ? word.slice(word.indexOf("=") + 1) : "") : word;
			const path = value === "" ? undefined : redirectPath(value, cwd, home);
			if (path !== undefined) paths.add(path);
		}
	}
	return [...paths];
}

/** The first rule for file tools of `kind` whose pattern matches one of `paths`. Rules without a pattern are tool-wide and do not apply to paths found in a command. */
function fileRuleFor(
	rules: readonly PermissionRule[],
	kind: "read" | "edit",
	paths: readonly (string | undefined)[],
	context: PathContext,
): PermissionRule | undefined {
	return rules.find((rule) => {
		const spec = rule.spec;
		return (
			spec !== undefined &&
			ruleCoversTool(rule, kind) &&
			paths.some((path) => path !== undefined && pathSpecMatches(spec, path, context))
		);
	});
}

/** The real path a redirection writes to; undefined when it names a variable and so cannot be known. */
function redirectPath(target: string, cwd: string, home: string): string | undefined {
	if (target.includes("$")) return undefined;
	const expanded = target === "~" ? home : target.startsWith("~/") ? `${home}/${target.slice(2)}` : target;
	return canonicalPath(resolve(cwd, expanded));
}

function isProtectedPath(absolutePath: string, projectRoot: string): boolean {
	if (PROTECTED_FILES.includes(basename(absolutePath))) return true;
	const fromRoot = relative(projectRoot, absolutePath);
	const segments = (fromRoot.startsWith("..") ? absolutePath : fromRoot).split(sep);
	return segments.some((segment) => PROTECTED_DIRS.includes(segment));
}
