// Runs one hook command: the event goes in as JSON on stdin, the answer comes back as exit code and output.

import { spawn } from "node:child_process";
import type { HookHandler } from "./config.ts";

/**
 * How a run ended. `ok`: exit code 0. `blocked`: exit code 2, the hook refuses what is about to
 * happen. `error`: any other exit code or a failure to start; it never blocks. `timeout`: stopped
 * after the handler's time limit; it never blocks either.
 */
export type HookRunStatus = "ok" | "blocked" | "error" | "timeout";

export interface HookRun {
	handler: HookHandler;
	status: HookRunStatus;
	exitCode: number | null;
	durationMs: number;
	stdout: string;
	stderr: string;
	/** The JSON object printed on a successful exit, when stdout was one. */
	output?: Record<string, unknown>;
}

export interface HookRunOptions {
	cwd: string;
	env: NodeJS.ProcessEnv;
}

/** Characters kept per output stream; a hook that prints more is cut off rather than held in memory. */
const OUTPUT_LIMIT = 1_000_000;

/** Run the handler's command through the system shell. Always resolves; failures are reported in the result. */
export function runHookCommand(
	handler: HookHandler,
	payload: Record<string, unknown>,
	options: HookRunOptions,
): Promise<HookRun> {
	const started = performance.now();
	return new Promise((resolve) => {
		const child = spawn(handler.command, {
			shell: true,
			cwd: options.cwd,
			env: options.env,
			stdio: ["pipe", "pipe", "pipe"],
			// Its own process group on POSIX, so a timeout stops everything the hook started.
			detached: process.platform !== "win32",
		});
		let stdout = "";
		let stderr = "";
		let timedOut = false;
		let settled = false;

		const finish = (exitCode: number | null, startError?: string): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			const status: HookRunStatus = timedOut
				? "timeout"
				: exitCode === 0
					? "ok"
					: exitCode === 2
						? "blocked"
						: "error";
			const output = status === "ok" ? parseJsonObject(stdout) : undefined;
			resolve({
				handler,
				status,
				exitCode,
				durationMs: Math.round(performance.now() - started),
				stdout,
				stderr: startError ?? stderr,
				...(output ? { output } : {}),
			});
		};
		const timer = setTimeout(() => {
			timedOut = true;
			try {
				if (process.platform === "win32" || child.pid === undefined) child.kill();
				else process.kill(-child.pid, "SIGKILL");
			} catch {
				// The process ended between the timer firing and the signal: nothing left to stop.
			}
		}, handler.timeoutSeconds * 1000);

		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			if (stdout.length < OUTPUT_LIMIT) stdout += chunk.slice(0, OUTPUT_LIMIT - stdout.length);
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			if (stderr.length < OUTPUT_LIMIT) stderr += chunk.slice(0, OUTPUT_LIMIT - stderr.length);
		});
		child.on("error", (error) => finish(null, error.message));
		child.on("close", (code) => finish(code));
		// A hook that exits without reading its input closes the pipe early; that is not a failure.
		child.stdin.on("error", () => {});
		child.stdin.end(JSON.stringify(payload));
	});
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	const trimmed = text.trim();
	if (!trimmed.startsWith("{")) return undefined;
	try {
		// Hook output is untrusted: only a JSON object is accepted, anything else is plain text.
		const parsed: unknown = JSON.parse(trimmed);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}
