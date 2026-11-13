import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkLog, WorkLogError } from "../../../src/shiro/workgraph/log.ts";

let dir: string;
let path: string;
const init = { sessionId: "s1", cwd: "/project" };
const fixedClock = { now: () => new Date("2026-11-13T00:00:00.000Z") };

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workgraph-log-"));
	path = join(dir, "nested", "log.jsonl");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function errorCode(run: () => unknown): string | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof WorkLogError) return error.code;
		throw error;
	}
	return undefined;
}

describe("create and append", () => {
	it("writes a header line and one line per event", () => {
		const log = WorkLog.create(path, init, fixedClock);
		log.append({ type: "user.message", text: "hi" });
		log.append({ type: "checkpoint", label: "first", sessionEntryId: null }, { agentId: "worker-1" });

		const lines = readFileSync(path, "utf8")
			.trimEnd()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(lines[0]).toEqual({
			type: "workgraph",
			version: 1,
			sessionId: "s1",
			cwd: "/project",
			createdAt: "2026-11-13T00:00:00.000Z",
		});
		expect(lines[1]).toMatchObject({ type: "user.message", seq: 0, parent: null, agentId: "main" });
		expect(lines[2]).toMatchObject({ type: "checkpoint", seq: 1, parent: 0, agentId: "worker-1" });
	});

	it("refuses to overwrite an existing log", () => {
		WorkLog.create(path, init);
		expect(errorCode(() => WorkLog.create(path, init))).toBe("exists");
	});
});

describe("open", () => {
	it("restores events and continues the sequence", () => {
		const first = WorkLog.create(path, init);
		first.append({ type: "user.message", text: "one" });

		const reopened = WorkLog.open(path);
		const event = reopened.append({ type: "user.message", text: "two" });

		expect(reopened.header.sessionId).toBe("s1");
		expect(event.seq).toBe(1);
		expect(reopened.events.map((entry) => entry.type)).toEqual(["user.message", "user.message"]);
	});

	it("cuts off a partial last line left by a crash", () => {
		const log = WorkLog.create(path, init);
		log.append({ type: "user.message", text: "kept" });
		appendFileSync(path, '{"type":"user.message","text":"torn');

		const reopened = WorkLog.open(path);
		reopened.append({ type: "user.message", text: "after" });

		expect(reopened.events.map((event) => (event.type === "user.message" ? event.text : ""))).toEqual([
			"kept",
			"after",
		]);
		expect(WorkLog.open(path).events).toHaveLength(2);
	});

	it("reports a damaged complete line with its line number", () => {
		const log = WorkLog.create(path, init);
		log.append({ type: "user.message", text: "ok" });
		appendFileSync(path, '{"type":"user.message","seq":1}\n');

		expect(() => WorkLog.open(path)).toThrow(/log\.jsonl:3: user\.message: "parent"/);
		expect(errorCode(() => WorkLog.open(path))).toBe("corrupt");
	});

	it("rejects a log written by a newer format version", () => {
		writeFileSync(join(dir, "new.jsonl"), `${JSON.stringify({ ...headerOf(), version: 99 })}\n`);
		expect(errorCode(() => WorkLog.open(join(dir, "new.jsonl")))).toBe("unsupported-version");
	});

	it("fails with code missing when there is no file", () => {
		expect(errorCode(() => WorkLog.open(join(dir, "absent.jsonl")))).toBe("missing");
	});

	it("openOrCreate creates once and then reopens", () => {
		WorkLog.openOrCreate(path, init).append({ type: "user.message", text: "a" });
		expect(WorkLog.openOrCreate(path, init).events).toHaveLength(1);
	});
});

describe("branch", () => {
	it("follows parent links and skips events a rewind left behind", () => {
		const log = WorkLog.create(path, init);
		log.append({ type: "user.message", text: "start" });
		const checkpoint = log.append({ type: "checkpoint", label: "c", sessionEntryId: null });
		log.append({ type: "user.message", text: "abandoned" });
		log.append(
			{ type: "rewind", checkpoint: checkpoint.seq, restored: [], deleted: [], conflicts: [] },
			{ parent: checkpoint.seq },
		);
		log.append({ type: "user.message", text: "new branch" });

		expect(log.branch().map((event) => event.seq)).toEqual([0, 1, 3, 4]);
		expect(log.events).toHaveLength(5);
	});

	it("is empty for a log without events", () => {
		expect(WorkLog.create(path, init).branch()).toEqual([]);
	});
});

function headerOf() {
	return { type: "workgraph", version: 1, sessionId: "s1", cwd: "/project", createdAt: "2026-11-13T00:00:00.000Z" };
}
