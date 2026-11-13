import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HookSources, hookId, loadHooks } from "../../../src/shiro/hooks/config.ts";

let root: string;
let sources: HookSources;

function put(path: string, content: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

function command(text: string, extra: Record<string, unknown> = {}) {
	return { type: "command", command: text, ...extra };
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "hooks-config-"));
	sources = {
		home: join(root, "home"),
		agentDir: join(root, "home", ".shiro", "agent"),
		projectDir: join(root, "project"),
		projectConfigDir: ".shiro",
		managedDir: join(root, "managed"),
		includeProject: true,
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("loadHooks", () => {
	it("returns nothing when no file exists", () => {
		expect(loadHooks(sources)).toEqual({ handlers: [], files: [], diagnostics: [] });
	});

	it("reads Shiro, Claude Code and Codex files from every layer", () => {
		const project = sources.projectDir;
		put(join(sources.managedDir, "hooks.json"), {
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [command("audit")] }] },
		});
		put(join(sources.agentDir, "hooks.json"), { hooks: { Stop: [{ hooks: [command("notify", { timeout: 5 })] }] } });
		put(join(sources.home, ".claude", "settings.json"), {
			permissions: { allow: ["Bash"] },
			hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [command("fmt", { statusMessage: "Formatting" })] }] },
		});
		put(join(sources.home, ".codex", "hooks.json"), {
			hooks: { SessionStart: [{ matcher: "startup", hooks: [command("ctx")] }] },
		});
		put(join(project, ".shiro", "hooks.json"), {
			hooks: { UserPromptSubmit: [{ hooks: [command("check-prompt")] }] },
		});
		put(join(project, ".claude", "settings.local.json"), {
			hooks: { SessionEnd: [{ matcher: "*", hooks: [command("bye")] }] },
		});
		put(join(project, ".codex", "hooks.json"), {
			hooks: { PreToolUse: [{ matcher: "", hooks: [command("guard")] }] },
		});

		const { handlers, files, diagnostics } = loadHooks(sources);
		expect(diagnostics).toEqual([]);
		expect(files).toHaveLength(7);
		expect(
			handlers.map((handler) => [
				handler.layer,
				handler.event,
				handler.matcher,
				handler.command,
				handler.timeoutSeconds,
			]),
		).toEqual([
			["managed", "PreToolUse", "Bash", "audit", 60],
			["user", "Stop", undefined, "notify", 5],
			["user", "PostToolUse", "Edit|Write", "fmt", 60],
			["user", "SessionStart", "startup", "ctx", 60],
			["project", "UserPromptSubmit", undefined, "check-prompt", 60],
			["project", "SessionEnd", undefined, "bye", 60],
			["project", "PreToolUse", undefined, "guard", 60],
		]);
		expect(handlers[2].statusMessage).toBe("Formatting");
		expect(handlers[2].source).toBe(join(sources.home, ".claude", "settings.json"));
		expect(handlers[0].id).toBe(hookId("PreToolUse", "Bash", "audit"));
	});

	it("skips project files when the project is not trusted", () => {
		put(join(sources.projectDir, ".shiro", "hooks.json"), { hooks: { Stop: [{ hooks: [command("x")] }] } });
		expect(loadHooks({ ...sources, includeProject: false }).handlers).toEqual([]);
	});

	it("keeps a hook registered twice only once, and tells different matchers apart", () => {
		const hooks = {
			hooks: {
				PreToolUse: [
					{ matcher: "Bash", hooks: [command("guard"), command("guard")] },
					{ hooks: [command("guard")] },
				],
			},
		};
		put(join(sources.agentDir, "hooks.json"), hooks);
		put(join(sources.home, ".codex", "hooks.json"), hooks);
		expect(loadHooks(sources).handlers.map((handler) => handler.matcher)).toEqual(["Bash", undefined]);
	});

	it("does not list a settings file that has no hooks", () => {
		put(join(sources.home, ".claude", "settings.json"), { permissions: {} });
		expect(loadHooks(sources).files).toEqual([]);
	});

	it("reports what it cannot use and keeps the rest", () => {
		const file = join(sources.agentDir, "hooks.json");
		put(file, {
			hooks: {
				PreCompact: [{ hooks: [command("x")] }],
				PreToolUse: [
					{ matcher: "(", hooks: [command("bad-regex")] },
					{ matcher: 3, hooks: [command("bad-matcher")] },
					{ hooks: [{ type: "prompt", prompt: "judge" }, command("   "), command("kept", { timeout: -1 })] },
					{ command: "no hooks list" },
				],
				Stop: { hooks: [] },
			},
		});
		put(join(sources.home, ".codex", "hooks.json"), "{ torn");
		put(join(sources.home, ".claude", "settings.json"), { hooks: [] });

		const { handlers, diagnostics } = loadHooks(sources);
		expect(handlers.map((handler) => [handler.command, handler.timeoutSeconds])).toEqual([["kept", 60]]);
		expect(diagnostics).toEqual([
			`${file}: hooks for the event PreCompact are not run by this version and were skipped`,
			`${file}: PreToolUse matcher "(" is not a valid regular expression`,
			`${file}: a PreToolUse matcher must be a string`,
			`${file}: PreToolUse hook of type "prompt" is not run by this version and was skipped`,
			`${file}: a PreToolUse command hook needs a non-empty "command"`,
			`${file}: every PreToolUse entry needs a "hooks" list`,
			`${file}: Stop must be a list`,
			`${join(sources.home, ".claude", "settings.json")}: "hooks" must be an object keyed by event name`,
			expect.stringContaining(`${join(sources.home, ".codex", "hooks.json")}: `),
		]);
	});
});
