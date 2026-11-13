import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runHookCommand } from "../../../src/shiro/hooks/runner.ts";
import { scriptHook } from "./script-hook.ts";

let dir: string;
const env = { ...process.env, HOOK_TEST_VALUE: "from-env" };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hooks-runner-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function run(body: string, payload: Record<string, unknown> = {}, timeoutSeconds = 20) {
	return runHookCommand(scriptHook(dir, "PreToolUse", body, { timeoutSeconds }), payload, { cwd: dir, env });
}

describe("runHookCommand", () => {
	it("passes the event on stdin and the environment and working directory to the command", async () => {
		const result = await run(
			'fs.writeFileSync("seen.json", JSON.stringify({ tool: event.tool_name, env: process.env.HOOK_TEST_VALUE }));',
			{ tool_name: "Bash" },
		);
		expect(result.status).toBe("ok");
		expect(JSON.parse(readFileSync(join(dir, "seen.json"), "utf8"))).toEqual({ tool: "Bash", env: "from-env" });
	});

	it("returns a printed JSON object as output", async () => {
		const result = await run('console.log(JSON.stringify({ decision: "block", reason: "no" }));');
		expect(result).toMatchObject({ status: "ok", exitCode: 0, output: { decision: "block", reason: "no" } });
	});

	it("keeps other output as plain text", async () => {
		for (const body of [
			'console.log("remember: use pnpm");',
			'console.log("[1, 2]");',
			'console.log("{ not json");',
		]) {
			const result = await run(body);
			expect(result.status).toBe("ok");
			expect(result.output).toBeUndefined();
			expect(result.stdout.trim()).not.toBe("");
		}
	});

	it("reports exit code 2 as blocked with the reason from stderr", async () => {
		const result = await run('console.error("rm is not allowed here"); process.exit(2);');
		expect(result).toMatchObject({ status: "blocked", exitCode: 2 });
		expect(result.stderr.trim()).toBe("rm is not allowed here");
	});

	it("reports any other failure as a non-blocking error and ignores its stdout", async () => {
		const result = await run('console.log(JSON.stringify({ decision: "block" })); process.exit(1);');
		expect(result).toMatchObject({ status: "error", exitCode: 1 });
		expect(result.output).toBeUndefined();
	});

	it("reports a command that does not exist as an error", async () => {
		const handler = { ...scriptHook(dir, "PreToolUse", ""), command: "definitely-not-a-real-command-shiro" };
		const result = await runHookCommand(handler, {}, { cwd: dir, env });
		expect(result.status).toBe("error");
		expect(result.exitCode).not.toBe(0);
	});

	it("does not fail when the command never reads its input", async () => {
		const handler = { ...scriptHook(dir, "PreToolUse", ""), command: "exit 0" };
		const result = await runHookCommand(handler, { big: "x".repeat(200_000) }, { cwd: dir, env });
		expect(result.status).toBe("ok");
	});

	it("stops a hook that runs past its time limit, with everything it started", async () => {
		const started = Date.now();
		const result = await run(
			'fs.writeFileSync("started", ""); await new Promise((resolve) => setTimeout(resolve, 30_000)); fs.writeFileSync("finished", "");',
			{},
			0.5,
		);
		expect(result.status).toBe("timeout");
		expect(Date.now() - started).toBeLessThan(10_000);
		expect(existsSync(join(dir, "started"))).toBe(true);
		expect(existsSync(join(dir, "finished"))).toBe(false);
	});
});
