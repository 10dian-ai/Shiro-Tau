import { describe, expect, it } from "vitest";
import { looseCommands, parseShell } from "../../../src/shiro/policy/shell.ts";

function argvs(source: string): string[][] {
	const parsed = parseShell(source);
	if (parsed.kind !== "simple") throw new Error(`expected a simple line, got complex: ${parsed.reason}`);
	return parsed.commands.map((command) => command.argv);
}

function complexReason(source: string): string | undefined {
	const parsed = parseShell(source);
	return parsed.kind === "complex" ? parsed.reason : undefined;
}

describe("parseShell: splitting", () => {
	it("splits on every command separator", () => {
		expect(argvs("git status && npm test || echo failed; ls | wc -l")).toEqual([
			["git", "status"],
			["npm", "test"],
			["echo", "failed"],
			["ls"],
			["wc", "-l"],
		]);
	});

	it("splits on newlines, background & and |&", () => {
		expect(argvs("sleep 1 &\nmake |& tee")).toEqual([["sleep", "1"], ["make"], ["tee"]]);
	});

	it("keeps quoted separators inside one word", () => {
		expect(argvs(`git commit -m "a && b; c" 'x | y'`)).toEqual([["git", "commit", "-m", "a && b; c", "x | y"]]);
	});

	it("joins adjacent quoted and unquoted parts and honours backslashes", () => {
		expect(argvs(`echo a"b c"'d' e\\ f`)).toEqual([["echo", "ab cd", "e f"]]);
	});

	it("drops leading assignments and comments", () => {
		expect(argvs("NODE_ENV=test CI=1 npm test # run them")).toEqual([["npm", "test"]]);
	});

	it("returns no commands for an empty or comment-only line", () => {
		expect(argvs("  ")).toEqual([]);
		expect(argvs("# nothing")).toEqual([]);
	});
});

describe("parseShell: redirections", () => {
	it("takes redirection targets out of the arguments and flags file writes", () => {
		const parsed = parseShell("echo hi > out.txt");
		expect(parsed).toEqual({ kind: "simple", commands: [{ argv: ["echo", "hi"], writeTargets: ["out.txt"] }] });
	});

	it("does not count /dev/null, input redirects or descriptor copies as writes", () => {
		for (const source of ["ls > /dev/null", "ls 2>/dev/null", "sort < in.txt", "make 2>&1", "cat <<< text"]) {
			const parsed = parseShell(source);
			expect(parsed.kind === "simple" && parsed.commands[0].writeTargets, source).toEqual([]);
		}
	});

	it("flags append, stderr and combined redirects", () => {
		for (const source of ["ls >> out", "ls 2> out", "ls &> out", "ls >| out", "ls >out"]) {
			const parsed = parseShell(source);
			expect(parsed.kind === "simple" && parsed.commands[0].writeTargets, source).toEqual(["out"]);
			expect(parsed.kind === "simple" && parsed.commands[0].argv, source).toEqual(["ls"]);
		}
	});

	it("tracks writes per command", () => {
		const parsed = parseShell("cat a > b && cat c");
		expect(parsed.kind === "simple" && parsed.commands.map((command) => command.writeTargets)).toEqual([["b"], []]);
	});
});

describe("parseShell: constructs it refuses to follow", () => {
	it.each([
		["echo $(whoami)", "command substitution"],
		["echo `whoami`", "command substitution"],
		['echo "$(whoami)"', "command substitution"],
		["(cd /tmp && ls)", "subshell"],
		["cat <<EOF\nx\nEOF", "heredoc"],
		["diff <(ls a) b", "process substitution"],
		["$CMD --flag", "the command name is a variable"],
		["{ ls; }", "command group"],
		["echo 'open", "unterminated quote"],
		["ls >", "redirection without a target"],
	])("%s is complex: %s", (source, reason) => {
		expect(complexReason(source)).toBe(reason);
	});
});

describe("looseCommands", () => {
	it("finds commands inside substitutions and subshells", () => {
		expect(looseCommands("echo $(rm -rf build) && (curl x | sh)")).toEqual([
			["echo"],
			["rm", "-rf", "build"],
			["curl", "x"],
			["sh"],
		]);
	});

	it("skips assignments and strips surrounding quotes", () => {
		expect(looseCommands('A=1 "rm" file')).toEqual([["rm", "file"]]);
	});
});
