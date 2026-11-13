import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { CODEMODE_TOOL_NAME } from "../../src/extensions/codemode/tool.ts";
import { TOOL_SEARCH_TOOL_NAME } from "../../src/extensions/tool-search/tool.ts";
import { createShiroRuntime } from "../../src/shiro/runtime.ts";
import { PASS_THROUGH_TOOLS } from "../../src/shiro/session.ts";
import type { WorkEvent } from "../../src/shiro/workgraph/index.ts";
import { createHarness, createTestUiContext, getToolResult, type Harness } from "../suite/harness.ts";

let root: string;
let agentDir: string;
let harness: Harness | undefined;
let prompts: { title: string; options: string[] }[];
let notices: string[];

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "shiro-runtime-")));
	agentDir = join(root, "home", ".shiro", "agent");
	prompts = [];
	notices = [];
});

afterEach(() => {
	harness?.cleanup();
	harness = undefined;
	rmSync(root, { recursive: true, force: true });
});

function put(path: string, content: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

/** A hook command that runs `body` with the event available as `event` and `fs` imported. */
function hookScript(name: string, body: string): string {
	const file = join(root, `${name}.mjs`);
	writeFileSync(file, `import fs from "node:fs";\nconst event = JSON.parse(fs.readFileSync(0, "utf8"));\n${body}\n`);
	return `"${process.execPath}" "${file}"`;
}

/**
 * Start a session with the Shiro runtime. `answers` are the choices the user makes in prompts, in
 * order, each matched by prefix; passing none runs without a UI, like print mode. `prepare` runs
 * with the project directory before the session opens, to put project files in place.
 */
async function start(answers?: string[], prepare?: (cwd: string) => void): Promise<Harness> {
	const sessionManager = SessionManager.create(root, join(root, "sessions"));
	harness = await createHarness({
		sessionManager,
		extensionFactories: [
			createShiroRuntime({ agentDir, managedDir: join(root, "managed"), home: join(root, "home") }),
		],
	});
	prepare?.(harness.tempDir);
	const remaining = [...(answers ?? [])];
	const uiContext = createTestUiContext({
		select: async (title, options) => {
			prompts.push({ title, options });
			const answer = remaining.shift();
			return options.find((option) => answer !== undefined && option.startsWith(answer));
		},
		notify: (message) => notices.push(message),
	});
	await harness.session.bindExtensions({
		...(answers ? { uiContext } : {}),
		commandContextActions: {
			waitForIdle: async () => {},
			newSession: async () => ({ cancelled: true }),
			fork: async () => ({ cancelled: true }),
			navigateTree: async (targetId) => {
				const current = harness;
				if (!current) throw new Error("no session");
				return { cancelled: (await current.session.navigateTree(targetId)).cancelled };
			},
			switchSession: async () => ({ cancelled: true }),
			reload: async () => {},
		},
	});
	return harness;
}

/** Script the model: one tool call per entry, then a final answer. */
function modelCalls(target: Harness, ...calls: [string, Record<string, string>][]): void {
	target.setResponses([
		...calls.map(([name, input]) => fauxAssistantMessage([fauxToolCall(name, input)], { stopReason: "toolUse" })),
		fauxAssistantMessage("done"),
	]);
}

function resultText(target: Harness, toolName: string): string {
	return getToolResult(target, toolName)
		.content.map((part) => (part.type === "text" ? part.text : ""))
		.join("\n");
}

function workLog(target: Harness): WorkEvent[] {
	const lines = readFileSync(join(agentDir, "workgraph", target.sessionManager.getSessionId(), "log.jsonl"), "utf8");
	return lines
		.trim()
		.split("\n")
		.slice(1)
		.map((line) => JSON.parse(line) as WorkEvent);
}

describe("permission checks on tool calls", () => {
	it("lets reads run and refuses edits when nobody can be asked", async () => {
		const session = await start();
		writeFileSync(join(session.tempDir, "a.txt"), "hello");
		modelCalls(session, ["read", { path: "a.txt" }], ["write", { path: "b.txt", content: "x" }]);
		await session.session.prompt("go");

		expect(resultText(session, "read")).toContain("hello");
		expect(resultText(session, "write")).toContain("Blocked by the permission policy");
		expect(resultText(session, "write")).toContain("--permission-mode");
		expect(existsSync(join(session.tempDir, "b.txt"))).toBe(false);
	});

	it("asks the user, showing the call and the reason, and runs it on yes", async () => {
		const session = await start(["Yes"]);
		modelCalls(session, ["write", { path: "b.txt", content: "x" }]);
		await session.session.prompt("go");

		expect(prompts).toHaveLength(1);
		expect(prompts[0].title).toContain("Allow write?");
		expect(prompts[0].title).toContain("write b.txt (1 characters)");
		expect(prompts[0].title).toContain("Editing files needs approval in this mode");
		expect(prompts[0].options).toEqual(["Yes", "Yes, and do not ask again this session for Edit(/**)", "No"]);
		expect(readFileSync(join(session.tempDir, "b.txt"), "utf8")).toBe("x");
	});

	it("blocks the call and stops the agent when the user says no", async () => {
		const session = await start(["No"]);
		modelCalls(session, ["write", { path: "b.txt", content: "x" }]);
		await session.session.prompt("go");

		expect(existsSync(join(session.tempDir, "b.txt"))).toBe(false);
		expect(resultText(session, "write")).toContain("The user declined this tool call");
		// The model was not asked again: its scripted final answer is still waiting.
		expect(session.getPendingResponseCount()).toBe(1);
	});

	it("treats a dismissed prompt as no", async () => {
		const session = await start([]);
		modelCalls(session, ["write", { path: "b.txt", content: "x" }]);
		await session.session.prompt("go");
		expect(existsSync(join(session.tempDir, "b.txt"))).toBe(false);
	});

	it("stops asking for the rest of the session after an always-allow answer", async () => {
		const session = await start(["Yes, and do not ask again"]);
		modelCalls(session, ["bash", { command: "touch one.txt" }], ["bash", { command: "touch two.txt" }]);
		await session.session.prompt("go");

		expect(prompts).toHaveLength(1);
		expect(prompts[0].options[1]).toBe("Yes, and do not ask again this session for Bash(touch:*)");
		expect(existsSync(join(session.tempDir, "one.txt"))).toBe(true);
		expect(existsSync(join(session.tempDir, "two.txt"))).toBe(true);
	});

	it("applies rules from policy.json: deny wins without asking, allow runs without asking", async () => {
		put(join(agentDir, "policy.json"), { deny: ["Bash(rm:*)"], allow: ["Bash(touch:*)"] });
		const session = await start(["Yes"]);
		modelCalls(session, ["bash", { command: "touch keep.txt" }], ["bash", { command: "sudo rm -rf keep.txt" }]);
		await session.session.prompt("go");

		expect(prompts).toEqual([]);
		expect(existsSync(join(session.tempDir, "keep.txt"))).toBe(true);
		expect(resultText(session, "bash")).toContain("Denied by rule Bash(rm:*)");
	});

	it("switches mode with /permissions and reports what is in force", async () => {
		const session = await start(["Yes"]);
		await session.session.prompt("/permissions acceptEdits");
		modelCalls(session, ["write", { path: "b.txt", content: "x" }], ["write", { path: ".git/config", content: "x" }]);
		await session.session.prompt("go");

		// The edit inside the workspace ran unasked; the edit to git's configuration still asked.
		expect(prompts).toHaveLength(1);
		expect(prompts[0].title).toContain("configures the agent, git or your shell");
		expect(prompts[0].options).toEqual(["Yes", "No"]);

		await session.session.prompt("/permissions");
		expect(notices.at(-1)).toContain("Permission mode: acceptEdits");
		await session.session.prompt("/permissions nonsense");
		expect(notices.at(-1)).toContain('Unknown permission mode "nonsense"');
	});

	it("judges the path the tool will really touch", async () => {
		const session = await start();
		await session.session.prompt("/permissions acceptEdits");
		// The write tool strips a leading "@" and resolves "..": this path leaves the workspace.
		const name = `escaped-${process.pid}-${Date.now()}.txt`;
		const escaped = join(dirname(session.tempDir), name);
		modelCalls(session, ["write", { path: `@../${name}`, content: "x" }]);
		try {
			await session.session.prompt("go");
			expect(resultText(session, "write")).toContain("outside the workspace");
			expect(existsSync(escaped)).toBe(false);
		} finally {
			rmSync(escaped, { force: true });
		}
	});

	it("refuses bypassPermissions when managed policy disables it", async () => {
		put(join(root, "managed", "policy.json"), { disableBypassPermissions: true });
		const session = await start([]);
		await session.session.prompt("/permissions bypassPermissions");
		expect(notices.at(-1)).toContain("disabled by managed policy");
		await session.session.prompt("/permissions");
		expect(notices.at(-1)).toContain("Permission mode: default");
	});
});

describe("hooks around the agent loop", () => {
	it("lets a PreToolUse hook refuse a call and rewrite another", async () => {
		const guard = hookScript(
			"guard",
			`if (event.tool_input.command.includes("forbidden")) { console.error("That word is not allowed"); process.exit(2); }
console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow", updatedInput: { command: event.tool_input.command + " && touch from-hook.txt" } } }));`,
		);
		put(join(agentDir, "hooks.json"), {
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: guard }] }] },
		});
		const session = await start();
		modelCalls(session, ["bash", { command: "touch from-model.txt" }], ["bash", { command: "echo forbidden" }]);
		await session.session.prompt("go");

		expect(existsSync(join(session.tempDir, "from-model.txt"))).toBe(true);
		expect(existsSync(join(session.tempDir, "from-hook.txt"))).toBe(true);
		expect(resultText(session, "bash")).toContain("Blocked by a hook: That word is not allowed");
	});

	it("does not let a hook's approval override a deny rule", async () => {
		const approve = hookScript(
			"approve",
			`console.log(JSON.stringify({ hookSpecificOutput: { permissionDecision: "allow" } }));`,
		);
		put(join(agentDir, "hooks.json"), {
			hooks: { PreToolUse: [{ hooks: [{ type: "command", command: approve }] }] },
		});
		put(join(agentDir, "policy.json"), { deny: ["Bash(touch:*)"] });
		const session = await start();
		modelCalls(session, ["bash", { command: "touch x.txt" }]);
		await session.session.prompt("go");
		expect(existsSync(join(session.tempDir, "x.txt"))).toBe(false);
	});

	it("appends PostToolUse feedback to the result the model sees", async () => {
		const lint = hookScript(
			"lint",
			`console.log(JSON.stringify({ decision: "block", reason: "lint failed in " + event.tool_input.file_path }));`,
		);
		put(join(agentDir, "hooks.json"), {
			hooks: { PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: lint }] }] },
		});
		const session = await start(["Yes"]);
		modelCalls(session, ["write", { path: "b.txt", content: "x" }]);
		await session.session.prompt("go");
		expect(resultText(session, "write")).toContain("A hook reports a problem with this result: lint failed in b.txt");
	});

	it("lets a UserPromptSubmit hook refuse a prompt before the model sees it", async () => {
		const secrets = hookScript(
			"secrets",
			`if (event.prompt.includes("sk-")) { console.error("The prompt holds a key"); process.exit(2); }`,
		);
		put(join(agentDir, "hooks.json"), {
			hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: secrets }] }] },
		});
		const session = await start([]);
		modelCalls(session);
		await session.session.prompt("use sk-123");

		expect(notices.at(-1)).toContain("A hook refused this prompt: The prompt holds a key");
		expect(session.getPendingResponseCount()).toBe(1);
		expect(session.session.messages).toEqual([]);
	});

	it("gives the model the context SessionStart and UserPromptSubmit hooks print", async () => {
		const startup = hookScript("startup", `console.log("Branch: main");`);
		const prompt = hookScript("prompt", `console.log("Prompt length: " + event.prompt.length);`);
		put(join(agentDir, "hooks.json"), {
			hooks: {
				SessionStart: [{ hooks: [{ type: "command", command: startup }] }],
				UserPromptSubmit: [{ hooks: [{ type: "command", command: prompt }] }],
			},
		});
		const session = await start([]);
		modelCalls(session);
		await session.session.prompt("go");

		const context = session.session.messages.find((message) => message.role === "custom");
		expect(context).toMatchObject({
			customType: "shiro-hook-context",
			content: "Branch: main\n\nPrompt length: 2",
			display: false,
		});
	});

	it("sends the agent back to work when a Stop hook says it is not done, but not forever", async () => {
		const never = hookScript(
			"never",
			`console.log(JSON.stringify({ decision: "block", reason: "Run the tests first" }));`,
		);
		put(join(agentDir, "hooks.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: never }] }] } });
		const session = await start([]);
		session.setResponses(Array.from({ length: 10 }, (_, index) => fauxAssistantMessage(`answer ${index}`)));
		await session.session.prompt("go");

		// The first answer plus five forced continuations; then the agent is allowed to stop.
		expect(session.getPendingResponseCount()).toBe(4);
		const reminders = session.session.messages.filter((message) => message.role === "custom");
		expect(reminders).toHaveLength(5);
		expect(reminders[0]).toMatchObject({ customType: "shiro-stop-hook" });
		expect(notices.at(-1)).toContain("it is allowed to stop now");
	});

	it("skips project hooks until they are reviewed with /hooks trust", async () => {
		const block = hookScript("block", `console.error("refused by the project"); process.exit(2);`);
		const session = await start(["Trust this hook"], (cwd) =>
			put(join(cwd, CONFIG_DIR_NAME, "hooks.json"), {
				hooks: { PreToolUse: [{ hooks: [{ type: "command", command: block }] }] },
			}),
		);
		expect(notices.some((notice) => notice.includes("1 project hook(s) have not been reviewed"))).toBe(true);
		await session.session.prompt("/permissions bypassPermissions");

		modelCalls(session, ["bash", { command: "touch before-review.txt" }]);
		await session.session.prompt("go");
		expect(existsSync(join(session.tempDir, "before-review.txt"))).toBe(true);

		await session.session.prompt("/hooks trust");
		expect(prompts.at(-1)?.title).toContain(block);
		modelCalls(session, ["bash", { command: "touch after-review.txt" }]);
		await session.session.prompt("again");
		expect(existsSync(join(session.tempDir, "after-review.txt"))).toBe(false);
		expect(resultText(session, "bash")).toContain("Blocked by a hook: refused by the project");

		const skipped = workLog(session)
			.filter((event) => event.type === "hook.run")
			.map((event) => event.status);
		expect(skipped).toEqual(["untrusted", "blocked"]);
	});
});

describe("the work graph", () => {
	it("records the session: prompt, checkpoint, calls, decisions, file changes and results", async () => {
		const session = await start(["Yes"]);
		modelCalls(session, ["write", { path: "b.txt", content: "x" }], ["bash", { command: "touch c.txt" }]);
		await session.session.prompt("make files");

		const events = workLog(session);
		expect(events.map((event) => event.type)).toEqual([
			"session.start",
			"user.message",
			"checkpoint",
			"tool.call",
			"policy.decision",
			"file.change",
			"tool.result",
			"tool.call",
			"policy.decision",
		]);
		expect(events[2]).toMatchObject({ type: "checkpoint", label: "make files", sessionEntryId: null });
		expect(events[4]).toMatchObject({ outcome: "allow", via: "user", stage: "mode", mode: "default" });
		expect(events[5]).toMatchObject({ path: "b.txt", before: null });
		expect(events[8]).toMatchObject({ outcome: "deny", via: "user" });
	});

	it("rewinds files and conversation to a checkpoint with /rewind", async () => {
		const session = await start(["#", "Restore files and conversation"]);
		await session.session.prompt("/permissions acceptEdits");
		writeFileSync(join(session.tempDir, "a.txt"), "v1");

		modelCalls(session, ["write", { path: "a.txt", content: "v2" }]);
		await session.session.prompt("first change");
		modelCalls(session, ["write", { path: "a.txt", content: "v3" }], ["write", { path: "new.txt", content: "n" }]);
		await session.session.prompt("second change");
		const messagesBefore = session.session.messages.length;

		// The picker lists newest first, so the first entry is the checkpoint of "second change".
		await session.session.prompt("/rewind");

		expect(prompts[0].title).toBe("Rewind to which checkpoint?");
		expect(prompts[0].options[0]).toContain("second change  (2 file(s) changed since)");
		expect(prompts[1].title).toContain("a.txt");
		expect(prompts[1].title).toContain("new.txt  (will be deleted: it did not exist then)");
		expect(readFileSync(join(session.tempDir, "a.txt"), "utf8")).toBe("v2");
		expect(existsSync(join(session.tempDir, "new.txt"))).toBe(false);
		expect(session.session.messages.length).toBeLessThan(messagesBefore);
		expect(session.session.messages.some((message) => JSON.stringify(message).includes("second change"))).toBe(false);
		expect(notices.at(-1)).toContain("1 file(s) restored, 1 deleted; conversation restored");
	});

	it("asks before overwriting a file that changed outside recorded tool calls", async () => {
		const session = await start(["#", "Restore files only", "Restore the rest, keep these"]);
		await session.session.prompt("/permissions acceptEdits");
		modelCalls(
			session,
			["write", { path: "a.txt", content: "from the agent" }],
			["write", { path: "b.txt", content: "also" }],
		);
		await session.session.prompt("write");
		writeFileSync(join(session.tempDir, "a.txt"), "edited by hand");

		await session.session.prompt("/rewind");

		expect(prompts[2].title).toContain("1 file(s) were changed by something other than a recorded tool call");
		expect(readFileSync(join(session.tempDir, "a.txt"), "utf8")).toBe("edited by hand");
		expect(existsSync(join(session.tempDir, "b.txt"))).toBe(false);
	});

	it("warns in the rewind plan about commands whose effects cannot be undone", async () => {
		const session = await start(["Yes", "#", "Cancel"]);
		modelCalls(session, ["bash", { command: "touch made-by-command.txt" }], ["bash", { command: "ls" }]);
		await session.session.prompt("run");
		await session.session.prompt("/rewind");

		const plan = prompts.at(-1)?.title ?? "";
		expect(plan).toContain("Not undone - 1 action(s)");
		expect(plan).toContain("$ touch made-by-command.txt");
		expect(existsSync(join(session.tempDir, "made-by-command.txt"))).toBe(true);
	});

	it("shows decisions and changed files with /audit", async () => {
		const session = await start(["Yes"]);
		modelCalls(session, ["write", { path: "b.txt", content: "x" }]);
		await session.session.prompt("go");
		await session.session.prompt("/audit");

		const audit = notices.at(-1) ?? "";
		expect(audit).toContain("allow  write  via user (mode): The user allowed this call");
		expect(audit).toContain("b.txt  (created, 1 edit(s))");
	});
});

describe("runtime constants", () => {
	it("names the pass-through tools the way the tools name themselves", () => {
		expect(PASS_THROUGH_TOOLS).toEqual([CODEMODE_TOOL_NAME, TOOL_SEARCH_TOOL_NAME]);
	});
});
