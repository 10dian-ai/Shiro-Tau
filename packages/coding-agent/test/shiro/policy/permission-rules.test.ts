import { describe, expect, it } from "vitest";
import {
	commandSpecMatches,
	parsePermissionRule,
	pathSpecMatches,
	requestPath,
	ruleCoversTool,
	toolKind,
} from "../../../src/shiro/policy/permission-rules.ts";

const context = { cwd: "/work/app/packages/ui", projectRoot: "/work/app", home: "/home/me" };

describe("parsePermissionRule", () => {
	it("parses a bare tool and a tool with a pattern", () => {
		expect(parsePermissionRule(" Bash ", "f")).toEqual({ tool: "Bash", text: "Bash", source: "f" });
		expect(parsePermissionRule("Bash(npm run test:*)", "f")).toEqual({
			tool: "Bash",
			spec: "npm run test:*",
			text: "Bash(npm run test:*)",
			source: "f",
		});
	});

	it("keeps parentheses inside the pattern and treats an empty pattern as none", () => {
		expect(parsePermissionRule("Bash(echo (hi))", "f").spec).toBe("echo (hi)");
		expect(parsePermissionRule("Read()", "f").spec).toBeUndefined();
	});

	it("rejects text that is not a rule", () => {
		expect(() => parsePermissionRule("Bash(npm", "f")).toThrow(/Invalid permission rule/);
		expect(() => parsePermissionRule("two words", "f")).toThrow(/Invalid permission rule/);
	});
});

describe("toolKind and ruleCoversTool", () => {
	it("classifies the built-in tools", () => {
		expect(["read", "grep", "find", "ls"].map(toolKind)).toEqual(["read", "read", "read", "read"]);
		expect(["edit", "write"].map(toolKind)).toEqual(["edit", "edit"]);
		expect(["bash", "powershell"].map(toolKind)).toEqual(["execute", "execute"]);
		expect(toolKind("mcp__github__create_issue")).toBe("other");
	});

	it("maps Claude Code tool names onto tool families", () => {
		const covers = (rule: string, tool: string): boolean => ruleCoversTool(parsePermissionRule(rule, "f"), tool);
		expect(covers("Read", "grep")).toBe(true);
		expect(covers("Edit", "write")).toBe(true);
		expect(covers("Write", "edit")).toBe(true);
		expect(covers("Glob", "find")).toBe(true);
		expect(covers("Bash", "powershell")).toBe(false);
		expect(covers("Read", "edit")).toBe(false);
	});

	it("matches MCP tools exactly, by server prefix or by glob", () => {
		const covers = (rule: string, tool: string): boolean => ruleCoversTool(parsePermissionRule(rule, "f"), tool);
		expect(covers("mcp__github__create_issue", "mcp__github__create_issue")).toBe(true);
		expect(covers("mcp__github", "mcp__github__create_issue")).toBe(true);
		expect(covers("mcp__git", "mcp__github__create_issue")).toBe(false);
		expect(covers("mcp__github__get_*", "mcp__github__get_issue")).toBe(true);
		expect(covers("mcp__github__get_*", "mcp__github__create_issue")).toBe(false);
	});
});

describe("commandSpecMatches", () => {
	it("treats :* as a word-boundary prefix", () => {
		expect(commandSpecMatches("npm run:*", "npm run build")).toBe(true);
		expect(commandSpecMatches("npm run:*", "npm run")).toBe(true);
		expect(commandSpecMatches("npm run:*", "npm runner")).toBe(false);
	});

	it("matches * anywhere and requires an exact match without it", () => {
		expect(commandSpecMatches("git * main", "git push origin main")).toBe(true);
		expect(commandSpecMatches("git status", "git status")).toBe(true);
		expect(commandSpecMatches("git status", "git status --short")).toBe(false);
		expect(commandSpecMatches("echo a.b", "echo aXb")).toBe(false);
	});
});

describe("pathSpecMatches", () => {
	it("anchors patterns the way Claude Code does", () => {
		expect(pathSpecMatches("//etc/hosts", "/etc/hosts", context)).toBe(true);
		expect(pathSpecMatches("~/.ssh/**", "/home/me/.ssh/id_ed25519", context)).toBe(true);
		expect(pathSpecMatches("/src/**", "/work/app/src/a/b.ts", context)).toBe(true);
		expect(pathSpecMatches("/src/**", "/work/app/packages/ui/src/b.ts", context)).toBe(false);
		expect(pathSpecMatches("src/*.ts", "/work/app/packages/ui/src/b.ts", context)).toBe(true);
		expect(pathSpecMatches("./src/*.ts", "/work/app/packages/ui/src/deep/b.ts", context)).toBe(false);
	});

	it("matches a pattern without a slash against the file name at any depth", () => {
		expect(pathSpecMatches(".env", "/work/app/packages/ui/.env", context)).toBe(true);
		expect(pathSpecMatches("*.pem", "/anywhere/key.pem", context)).toBe(true);
		expect(pathSpecMatches(".env", "/work/app/.env.example", context)).toBe(false);
	});

	it("lets **/ match zero or more directories and * stay within one", () => {
		expect(pathSpecMatches("/src/**/a.ts", "/work/app/src/a.ts", context)).toBe(true);
		expect(pathSpecMatches("/src/**/a.ts", "/work/app/src/x/y/a.ts", context)).toBe(true);
		expect(pathSpecMatches("/src/*", "/work/app/src/x/a.ts", context)).toBe(false);
		expect(pathSpecMatches("/**", "/work/app/anything/at/all", context)).toBe(true);
		expect(pathSpecMatches("/**", "/work/other/file", context)).toBe(false);
	});
});

describe("requestPath", () => {
	it("resolves relative, home and absolute paths and defaults to the working directory", () => {
		expect(requestPath({ path: "src/../a.ts" }, "/work/app", "/home/me")).toBe("/work/app/a.ts");
		expect(requestPath({ path: "~/notes.md" }, "/work/app", "/home/me")).toBe("/home/me/notes.md");
		expect(requestPath({ path: "/etc/../etc/hosts" }, "/work/app", "/home/me")).toBe("/etc/hosts");
		expect(requestPath({ pattern: "TODO" }, "/work/app", "/home/me")).toBe("/work/app");
	});
});
