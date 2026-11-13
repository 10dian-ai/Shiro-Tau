import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { HookHandler } from "../../../src/shiro/hooks/config.ts";
import { HookDispatcher, type HookRunRecord, type HookSession } from "../../../src/shiro/hooks/dispatch.ts";
import { HookTrustStore } from "../../../src/shiro/hooks/trust.ts";
import { scriptHook } from "./script-hook.ts";

let dir: string;
let session: HookSession;
let records: HookRunRecord[];
let trust: HookTrustStore;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hooks-dispatch-"));
	session = {
		sessionId: "s1",
		transcriptPath: join(dir, "session.jsonl"),
		cwd: dir,
		projectDir: dir,
		permissionMode: "default",
	};
	records = [];
	trust = new HookTrustStore(join(dir, "trust.json"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function dispatcher(...handlers: HookHandler[]): HookDispatcher {
	return new HookDispatcher({ handlers, trust, env: process.env, onRun: (record) => records.push(record) });
}

const print = (value: unknown): string => `console.log(${JSON.stringify(JSON.stringify(value))});`;
const bashCall = { toolName: "bash", toolCallId: "t1", input: { command: "rm -rf build" } };
const writeCall = { toolName: "write", toolCallId: "t2", input: { path: "a.ts", content: "x" } };

describe("preToolUse", () => {
	it("gives hooks the session and the call, under the names hooks expect", async () => {
		const hook = scriptHook(
			dir,
			"PreToolUse",
			"console.log(JSON.stringify({ hookSpecificOutput: { additionalContext: JSON.stringify(event) } }));",
		);
		const outcome = await dispatcher(hook).preToolUse(writeCall, session);
		expect(JSON.parse(outcome.additionalContext[0])).toEqual({
			session_id: "s1",
			transcript_path: join(dir, "session.jsonl"),
			cwd: dir,
			hook_event_name: "PreToolUse",
			permission_mode: "default",
			tool_name: "Write",
			tool_use_id: "t2",
			tool_input: { path: "a.ts", content: "x", file_path: "a.ts" },
		});
	});

	it("sets the project directory variables", async () => {
		const hook = scriptHook(
			dir,
			"PreToolUse",
			"console.log(JSON.stringify({ additionalContext: process.env.SHIRO_PROJECT_DIR + '|' + process.env.CLAUDE_PROJECT_DIR }));",
		);
		expect((await dispatcher(hook).preToolUse(bashCall, session)).additionalContext).toEqual([`${dir}|${dir}`]);
	});

	it("refuses the call on a deny decision, on exit code 2 and on the older block decision", async () => {
		const refusals = [
			scriptHook(
				dir,
				"PreToolUse",
				print({
					hookSpecificOutput: { permissionDecision: "deny", permissionDecisionReason: "Never delete build" },
				}),
			),
			scriptHook(dir, "PreToolUse", 'console.error("Never delete build"); process.exit(2);'),
			scriptHook(dir, "PreToolUse", print({ decision: "block", reason: "Never delete build" })),
			scriptHook(dir, "PreToolUse", print({ continue: false, stopReason: "Never delete build" })),
		];
		for (const hook of refusals) {
			expect((await dispatcher(hook).preToolUse(bashCall, session)).blocked).toBe("Never delete build");
		}
	});

	it("lets one refusal beat any number of approvals", async () => {
		const allow = scriptHook(dir, "PreToolUse", print({ hookSpecificOutput: { permissionDecision: "allow" } }));
		const deny = scriptHook(dir, "PreToolUse", "process.exit(2);");
		const outcome = await dispatcher(allow, deny).preToolUse(bashCall, session);
		expect(outcome.blocked).toContain("Blocked by hook");
		expect(outcome.permission).toBeUndefined();
	});

	it("reports allow and ask, with ask winning", async () => {
		const allow = scriptHook(dir, "PreToolUse", print({ hookSpecificOutput: { permissionDecision: "allow" } }));
		const legacy = scriptHook(dir, "PreToolUse", print({ decision: "approve" }));
		const ask = scriptHook(dir, "PreToolUse", print({ hookSpecificOutput: { permissionDecision: "ask" } }));
		expect((await dispatcher(allow).preToolUse(bashCall, session)).permission).toBe("allow");
		expect((await dispatcher(legacy).preToolUse(bashCall, session)).permission).toBe("allow");
		expect((await dispatcher(allow, ask).preToolUse(bashCall, session)).permission).toBe("ask");
		expect((await dispatcher(ask, allow).preToolUse(bashCall, session)).permission).toBe("ask");
	});

	it("returns rewritten input in the tool's own fields", async () => {
		const hook = scriptHook(
			dir,
			"PreToolUse",
			'console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { ...event.tool_input, file_path: "src/" + event.tool_input.file_path } } }));',
		);
		const outcome = await dispatcher(hook).preToolUse(writeCall, session);
		expect(outcome.updatedInput).toEqual({ path: "src/a.ts", content: "x" });
		expect((await dispatcher().preToolUse(writeCall, session)).updatedInput).toBeUndefined();
	});

	it("matches hooks against the hook-side tool name and the tool's own, as a whole-name pattern", async () => {
		const marker = (name: string): string => print({ additionalContext: name });
		const hooks = [
			scriptHook(dir, "PreToolUse", marker("Bash"), { matcher: "Bash" }),
			scriptHook(dir, "PreToolUse", marker("own-name"), { matcher: "bash" }),
			scriptHook(dir, "PreToolUse", marker("alternatives"), { matcher: "Edit|Write|Bash" }),
			scriptHook(dir, "PreToolUse", marker("everything")),
			scriptHook(dir, "PreToolUse", marker("other-tool"), { matcher: "Write" }),
			scriptHook(dir, "PreToolUse", marker("partial"), { matcher: "Bas" }),
			scriptHook(dir, "PreToolUse", marker("wildcard"), { matcher: "Ba.*" }),
		];
		const outcome = await dispatcher(...hooks).preToolUse(bashCall, session);
		expect(outcome.additionalContext).toEqual(["Bash", "own-name", "alternatives", "everything", "wildcard"]);
	});

	it("runs hooks for one event at the same time", async () => {
		// The first hook only succeeds if the second one starts while it is still running.
		const waits = scriptHook(
			dir,
			"PreToolUse",
			'for (let i = 0; i < 100 && !fs.existsSync("second-started"); i++) await new Promise((resolve) => setTimeout(resolve, 50));\nprocess.exit(fs.existsSync("second-started") ? 0 : 1);',
		);
		const second = scriptHook(dir, "PreToolUse", 'fs.writeFileSync("second-started", "");');
		await dispatcher(waits, second).preToolUse(bashCall, session);
		expect(records.map((record) => record.status)).toEqual(["ok", "ok"]);
	});

	it("skips project hooks nobody reviewed, records the skip, and runs them once trusted", async () => {
		const hook = scriptHook(dir, "PreToolUse", "process.exit(2);", { layer: "project" });
		expect((await dispatcher(hook).preToolUse(bashCall, session)).blocked).toBeUndefined();
		expect(records).toEqual([{ handler: hook, status: "untrusted", exitCode: null, durationMs: 0, stderr: "" }]);
		trust.trust(hook);
		expect((await dispatcher(hook).preToolUse(bashCall, session)).blocked).toBeDefined();
	});

	it("does not let a failing or slow hook block the call", async () => {
		const crash = scriptHook(dir, "PreToolUse", 'console.error("boom"); process.exit(1);');
		const slow = scriptHook(dir, "PreToolUse", "await new Promise((resolve) => setTimeout(resolve, 30_000));", {
			timeoutSeconds: 0.3,
		});
		const outcome = await dispatcher(crash, slow).preToolUse(bashCall, session);
		expect(outcome).toEqual({ additionalContext: [] });
		expect(records.map((record) => [record.status, record.exitCode, record.stderr])).toEqual([
			["error", 1, "boom"],
			["timeout", null, ""],
		]);
	});
});

describe("postToolUse", () => {
	it("passes the tool result to hooks and returns their feedback", async () => {
		const lint = scriptHook(
			dir,
			"PostToolUse",
			'console.log(JSON.stringify({ decision: "block", reason: "lint failed after " + event.tool_name + ": " + event.tool_response.text }));',
			{ matcher: "Edit|Write" },
		);
		const exit2 = scriptHook(dir, "PostToolUse", 'console.error("types broke"); process.exit(2);');
		const quiet = scriptHook(dir, "PostToolUse", print({ hookSpecificOutput: { additionalContext: "formatted" } }));
		const outcome = await dispatcher(lint, exit2, quiet).postToolUse(writeCall, { text: "wrote 1 byte" }, session);
		expect(outcome).toEqual({
			feedback: ["lint failed after Write: wrote 1 byte", "types broke"],
			additionalContext: ["formatted"],
		});
		expect((await dispatcher(lint).postToolUse(bashCall, {}, session)).feedback).toEqual([]);
	});
});

describe("userPromptSubmit", () => {
	it("adds plain output and JSON context to the prompt", async () => {
		const plain = scriptHook(dir, "UserPromptSubmit", 'console.log("Prompt was: " + event.prompt);');
		const json = scriptHook(
			dir,
			"UserPromptSubmit",
			print({ hookSpecificOutput: { additionalContext: "Branch: main" } }),
		);
		const outcome = await dispatcher(plain, json).userPromptSubmit("fix the bug", session);
		expect(outcome).toEqual({ additionalContext: ["Prompt was: fix the bug", "Branch: main"] });
	});

	it("refuses a prompt", async () => {
		const hook = scriptHook(
			dir,
			"UserPromptSubmit",
			print({ decision: "block", reason: "Prompt contains a secret" }),
		);
		expect((await dispatcher(hook).userPromptSubmit("key=abc", session)).blocked).toBe("Prompt contains a secret");
	});
});

describe("stop", () => {
	it("continues with the reasons of every hook that says the work is not done", async () => {
		const tests = scriptHook(
			dir,
			"Stop",
			'console.log(JSON.stringify({ decision: "block", reason: "Tests are failing; active=" + event.stop_hook_active }));',
		);
		const docs = scriptHook(dir, "Stop", 'console.error("Update the changelog"); process.exit(2);');
		const fine = scriptHook(dir, "Stop", "");
		expect(await dispatcher(tests, docs, fine).stop(true, session)).toEqual({
			continueWith: "Tests are failing; active=true\n\nUpdate the changelog",
		});
		expect(await dispatcher(fine).stop(false, session)).toEqual({});
	});
});

describe("session hooks", () => {
	it("matches session start hooks on the source and returns their context", async () => {
		const startup = scriptHook(dir, "SessionStart", 'console.log("Loaded from " + event.source);', {
			matcher: "startup",
		});
		const resume = scriptHook(dir, "SessionStart", 'console.log("resumed");', { matcher: "resume" });
		expect(await dispatcher(startup, resume).sessionStart("startup", session)).toEqual({
			additionalContext: ["Loaded from startup"],
		});
	});

	it("runs session end hooks with the reason", async () => {
		const hook = scriptHook(dir, "SessionEnd", 'if (event.reason !== "quit") process.exit(1);');
		const subject = dispatcher(hook);
		await subject.sessionEnd("quit", session);
		expect(records.map((record) => record.status)).toEqual(["ok"]);
		expect(subject.has("SessionEnd")).toBe(true);
		expect(subject.has("Stop")).toBe(false);
	});
});
