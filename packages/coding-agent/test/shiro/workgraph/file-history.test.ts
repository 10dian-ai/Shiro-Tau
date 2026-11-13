import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore } from "../../../src/shiro/workgraph/blob-store.ts";
import { FileHistory } from "../../../src/shiro/workgraph/file-history.ts";
import { WorkLog } from "../../../src/shiro/workgraph/log.ts";

let root: string;
let project: string;
let log: WorkLog;
let history: FileHistory;
let callCount = 0;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "workgraph-history-"));
	project = join(root, "project");
	mkdirSync(project);
	log = WorkLog.create(join(root, "state", "log.jsonl"), { sessionId: "s1", cwd: project });
	history = new FileHistory(log, new BlobStore(join(root, "state", "blobs")));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

/** Simulate one tool call that writes `content` to `name` (or deletes it when content is null). */
function toolWrites(name: string, content: string | null): void {
	const id = `call-${++callCount}`;
	const path = join(project, name);
	history.captureBefore(id, path);
	if (content === null) rmSync(path);
	else {
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, content);
	}
	history.recordAfter(id);
}

function read(name: string): string {
	return readFileSync(join(project, name), "utf8");
}

describe("recording changes", () => {
	it("logs created, modified and deleted files with paths relative to the project", () => {
		toolWrites("src/a.txt", "one");
		toolWrites("src/a.txt", "two");
		toolWrites("src/a.txt", null);

		const changes = log.events.filter((event) => event.type === "file.change");
		expect(changes.map((change) => change.path)).toEqual(["src/a.txt", "src/a.txt", "src/a.txt"]);
		expect(changes[0].before).toBeNull();
		expect(changes[1].before).toBe(changes[0].after);
		expect(changes[2].after).toBeNull();
	});

	it("logs nothing when the tool left the file as it was", () => {
		writeFileSync(join(project, "same.txt"), "same");
		history.captureBefore("noop", join(project, "same.txt"));
		expect(history.recordAfter("noop")).toEqual([]);
		expect(log.events).toHaveLength(0);
	});

	it("keeps an absolute path for files outside the project", () => {
		const outside = join(root, "outside.txt");
		history.captureBefore("out", outside);
		writeFileSync(outside, "x");
		expect(history.recordAfter("out")[0].path).toBe(outside);
	});
});

describe("rewind", () => {
	it("restores modified files, deletes created ones and recreates deleted ones", () => {
		writeFileSync(join(project, "kept.txt"), "original");
		writeFileSync(join(project, "removed.txt"), "to be removed");
		const checkpoint = history.checkpoint("before the task", "entry-1");
		toolWrites("kept.txt", "changed");
		toolWrites("kept.txt", "changed again");
		toolWrites("created.txt", "new");
		toolWrites("removed.txt", null);

		const result = history.rewind(checkpoint.seq);

		expect(read("kept.txt")).toBe("original");
		expect(read("removed.txt")).toBe("to be removed");
		expect(existsSync(join(project, "created.txt"))).toBe(false);
		expect(result.restored.sort()).toEqual(["kept.txt", "removed.txt"]);
		expect(result.deleted).toEqual(["created.txt"]);
		expect(result.conflicts).toEqual([]);
		expect(result.event.parent).toBe(checkpoint.seq);
	});

	it("leaves a file alone when something else changed it, unless forced", () => {
		writeFileSync(join(project, "a.txt"), "v1");
		const checkpoint = history.checkpoint("c", null);
		toolWrites("a.txt", "v2");
		writeFileSync(join(project, "a.txt"), "edited by the user");

		const careful = history.rewind(checkpoint.seq);
		expect(careful.conflicts).toEqual(["a.txt"]);
		expect(read("a.txt")).toBe("edited by the user");
	});

	it("reports conflicts before anything is rewound", () => {
		writeFileSync(join(project, "a.txt"), "v1");
		writeFileSync(join(project, "b.txt"), "v1");
		writeFileSync(join(project, "c.txt"), "v1");
		const checkpoint = history.checkpoint("c", null);
		toolWrites("a.txt", "v2");
		toolWrites("b.txt", "v2");
		toolWrites("c.txt", "v2");
		writeFileSync(join(project, "a.txt"), "edited by the user");
		// Already back at the checkpoint content: nothing to overwrite, so not a conflict.
		writeFileSync(join(project, "c.txt"), "v1");

		expect(history.findConflicts(history.planRewind(checkpoint.seq))).toEqual(["a.txt"]);
		expect(read("a.txt")).toBe("edited by the user");
		expect(read("b.txt")).toBe("v2");
	});

	it("overwrites outside changes when forced", () => {
		writeFileSync(join(project, "a.txt"), "v1");
		const checkpoint = history.checkpoint("c", null);
		toolWrites("a.txt", "v2");
		writeFileSync(join(project, "a.txt"), "edited by the user");

		const forced = history.rewind(checkpoint.seq, { force: true });
		expect(forced.restored).toEqual(["a.txt"]);
		expect(read("a.txt")).toBe("v1");
	});

	it("lists actions it cannot undo", () => {
		const checkpoint = history.checkpoint("c", null);
		log.append({ type: "irreversible", toolCallId: "t1", kind: "command", description: "npm publish" });

		expect(history.planRewind(checkpoint.seq).irreversible.map((event) => event.description)).toEqual([
			"npm publish",
		]);
	});

	it("only undoes the active branch after an earlier rewind", () => {
		writeFileSync(join(project, "a.txt"), "v1");
		const first = history.checkpoint("first", null);
		toolWrites("a.txt", "abandoned");
		history.rewind(first.seq);
		toolWrites("a.txt", "v2");
		const second = history.checkpoint("second", null);
		toolWrites("a.txt", "v3");

		history.rewind(second.seq);
		expect(read("a.txt")).toBe("v2");
		history.rewind(first.seq);
		expect(read("a.txt")).toBe("v1");
		expect(history.checkpoints().map((checkpoint) => checkpoint.label)).toEqual(["first"]);
	});

	it("rejects a sequence number that is not a checkpoint on the active branch", () => {
		toolWrites("a.txt", "x");
		expect(() => history.planRewind(0)).toThrow("No checkpoint 0 on the active branch");
	});

	it("survives reopening the log", () => {
		writeFileSync(join(project, "a.txt"), "v1");
		const checkpoint = history.checkpoint("c", null);
		toolWrites("a.txt", "v2");

		const reopened = new FileHistory(WorkLog.open(log.path), new BlobStore(join(root, "state", "blobs")));
		reopened.rewind(checkpoint.seq);
		expect(read("a.txt")).toBe("v1");
	});
});
