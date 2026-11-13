// Decides whether a shell command only reads: such commands run without approval in every mode.

import { isAbsolute, relative, resolve } from "node:path";
import { canonicalPath } from "./canonical-path.ts";
import type { SimpleCommand } from "./shell.ts";

/** Commands that never change anything, whatever their arguments. */
const ALWAYS_READ_ONLY = new Set([
	"basename",
	"cat",
	"cd",
	"cmp",
	"cut",
	"df",
	"diff",
	"dirname",
	"du",
	"echo",
	"egrep",
	"false",
	"fgrep",
	"file",
	"grep",
	"head",
	"id",
	"ls",
	"nl",
	"printf",
	"pwd",
	"readlink",
	"realpath",
	"stat",
	"tail",
	"test",
	"tr",
	"true",
	"uname",
	"wc",
	"which",
	"whoami",
	"[",
]);

/** Commands that read unless given one of these arguments (matched as a prefix). */
const READ_ONLY_UNLESS: Record<string, readonly string[]> = {
	date: ["-s", "--set"],
	find: ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprintf", "-fls"],
	rg: ["--pre"],
	sort: ["-o", "--output"],
	tree: ["-o"],
};

/** Git subcommands that only read, and the arguments each accepts; null accepts any. */
const GIT_READ_ONLY: Record<string, readonly string[] | null> = {
	blame: null,
	branch: ["-a", "-r", "-v", "-vv", "--list", "--show-current", "--all", "--remotes"],
	describe: null,
	diff: null,
	log: null,
	"ls-files": null,
	remote: ["-v", "--verbose"],
	"rev-parse": null,
	show: null,
	status: null,
};

/**
 * True when the command is known to only read and every path it names stays inside `roots`, which
 * must be real paths (no symbolic links). Unknown commands are never read-only: the list is an allowlist.
 */
export function isReadOnlyCommand(
	command: SimpleCommand,
	cwd: string,
	home: string,
	roots: readonly string[],
): boolean {
	if (command.writeTargets.length > 0) return false;
	const [name, ...args] = command.argv;
	if (!commandOnlyReads(name, args)) return false;
	return args.every((arg) => !looksLikeOutsidePath(arg, cwd, home, roots));
}

/** Whether `absolutePath` is one of `roots` or inside one. */
export function isInsideRoots(absolutePath: string, roots: readonly string[]): boolean {
	return roots.some((root) => {
		const fromRoot = relative(root, absolutePath);
		return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
	});
}

function commandOnlyReads(name: string, args: string[]): boolean {
	if (ALWAYS_READ_ONLY.has(name)) return true;
	const forbidden = READ_ONLY_UNLESS[name];
	if (forbidden) return !args.some((arg) => forbidden.some((flag) => arg === flag || arg.startsWith(flag)));
	if (name !== "git") return false;
	// A global option before the subcommand (`git -c ...`) can run anything, so it is not accepted.
	const [subcommand, ...rest] = args;
	if (subcommand === undefined || !Object.hasOwn(GIT_READ_ONLY, subcommand)) return false;
	if (rest.some((arg) => arg.startsWith("--output") || arg === "--ext-diff")) return false;
	const accepted = GIT_READ_ONLY[subcommand];
	return accepted === null || rest.every((arg) => accepted.includes(arg));
}

function looksLikeOutsidePath(arg: string, cwd: string, home: string, roots: readonly string[]): boolean {
	// For `--option=value`, the value is what may be a path.
	const value = arg.startsWith("-") && arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : arg;
	const expanded = value === "~" ? home : value.startsWith("~/") ? `${home}/${value.slice(2)}` : value;
	// An argument that mentions a variable could expand to any path.
	if (expanded.includes("$")) return true;
	// Every argument is treated as a possible path: a plain name can be a link that points outside.
	return !isInsideRoots(canonicalPath(resolve(cwd, expanded)), roots);
}
