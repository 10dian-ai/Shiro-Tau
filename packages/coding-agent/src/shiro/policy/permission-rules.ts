// Permission rules in the `Tool` / `Tool(spec)` form Claude Code settings use, and how they match a call.

import { basename, isAbsolute, resolve } from "node:path";

/** What a tool call does, as far as permissions care. */
export type ToolKind = "read" | "edit" | "execute" | "other";

/** One parsed rule. `spec` narrows it: a command pattern for shells, a path pattern for file tools. */
export interface PermissionRule {
	tool: string;
	spec?: string;
	/** The rule as written, for messages. */
	text: string;
	/** Where it came from: a file path or "session". */
	source: string;
}

/** Directories a path pattern can be anchored to. */
export interface PathContext {
	cwd: string;
	projectRoot: string;
	home: string;
}

const READ_TOOLS = ["read", "grep", "find", "ls"];
const EDIT_TOOLS = ["edit", "write"];
const SHELL_TOOLS = ["bash", "powershell"];

/** Rule tool names that stand for a family of built-in tools; keys are lower case. */
const FAMILIES: Record<string, readonly string[]> = {
	bash: ["bash"],
	powershell: ["powershell"],
	read: READ_TOOLS,
	grep: ["grep"],
	glob: ["find"],
	ls: ["ls"],
	edit: EDIT_TOOLS,
	write: EDIT_TOOLS,
	multiedit: EDIT_TOOLS,
};

/** Classify a tool by name. Tools this build does not know are "other". */
export function toolKind(toolName: string): ToolKind {
	if (READ_TOOLS.includes(toolName)) return "read";
	if (EDIT_TOOLS.includes(toolName)) return "edit";
	if (SHELL_TOOLS.includes(toolName)) return "execute";
	return "other";
}

/** Parse `Tool` or `Tool(spec)`. Throws when the text is neither. */
export function parsePermissionRule(text: string, source: string): PermissionRule {
	const match = /^([^()\s]+)(?:\(([\s\S]*)\))?$/.exec(text.trim());
	if (!match) throw new Error(`Invalid permission rule ${JSON.stringify(text)}: expected Tool or Tool(pattern)`);
	const spec = match[2];
	return { tool: match[1], text: text.trim(), source, ...(spec === undefined || spec === "" ? {} : { spec }) };
}

/** Whether the rule names this tool: by family (`Edit` covers edit and write), exact name, glob or MCP server prefix. */
export function ruleCoversTool(rule: PermissionRule, toolName: string): boolean {
	const family = FAMILIES[rule.tool.toLowerCase()];
	if (family) return family.includes(toolName);
	if (rule.tool.includes("*")) return globToRegExp(rule.tool, "command").test(toolName);
	return rule.tool === toolName || toolName.startsWith(`${rule.tool}__`);
}

/**
 * Whether a shell rule's spec matches one command, given as its words joined by spaces.
 * `npm run:*` is a prefix; otherwise `*` matches any text and no `*` means the exact command.
 */
export function commandSpecMatches(spec: string, commandText: string): boolean {
	if (spec.endsWith(":*")) {
		const prefix = spec.slice(0, -2);
		return commandText === prefix || commandText.startsWith(`${prefix} `);
	}
	return globToRegExp(spec, "command").test(commandText);
}

/**
 * Whether a file rule's spec matches an absolute path. Anchors follow Claude Code: `//x` is the
 * absolute path /x, `~/x` is under home, `/x` is under the project root, anything else is under
 * the working directory. A spec without a slash matches that file name at any depth.
 */
export function pathSpecMatches(spec: string, absolutePath: string, context: PathContext): boolean {
	if (!spec.includes("/")) return globToRegExp(spec, "path").test(basename(absolutePath));
	let pattern: string;
	if (spec.startsWith("//")) pattern = spec.slice(1);
	else if (spec.startsWith("~/")) pattern = `${context.home}/${spec.slice(2)}`;
	else if (spec.startsWith("/")) pattern = `${context.projectRoot}${spec}`;
	else pattern = `${context.cwd}/${spec.replace(/^\.\//, "")}`;
	return globToRegExp(pattern, "path").test(absolutePath);
}

/** The absolute path a file tool call targets; search tools default to the working directory. */
export function requestPath(input: Record<string, unknown>, cwd: string, home: string): string {
	const raw = typeof input.path === "string" && input.path !== "" ? input.path : ".";
	const expanded = raw === "~" ? home : raw.startsWith("~/") ? `${home}/${raw.slice(2)}` : raw;
	return isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
}

function globToRegExp(glob: string, flavor: "path" | "command"): RegExp {
	let pattern = "";
	for (let i = 0; i < glob.length; i++) {
		const char = glob[i];
		if (char === "*" && flavor === "command") pattern += "[\\s\\S]*";
		else if (char === "*" && glob[i + 1] === "*") {
			// `**/` also matches zero directories, so `src/**/a.ts` covers `src/a.ts`.
			if (glob[i + 2] === "/") {
				pattern += "(?:.*/)?";
				i += 2;
			} else {
				pattern += ".*";
				i += 1;
			}
		} else if (char === "*") pattern += "[^/]*";
		else if (char === "?" && flavor === "path") pattern += "[^/]";
		else pattern += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	}
	return new RegExp(`^${pattern}$`);
}
