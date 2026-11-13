import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BlobStore, hashContent } from "../../../src/shiro/workgraph/blob-store.ts";
import { parseWorkEvent, type WorkEvent, type WorkEventBody } from "../../../src/shiro/workgraph/events.ts";
import { auditTrail, changedFiles, project } from "../../../src/shiro/workgraph/projections.ts";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "workgraph-blobs-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("BlobStore", () => {
	it("returns the same hash for the same content and stores it once", () => {
		const store = new BlobStore(dir);
		const first = store.put(Buffer.from("hello"));
		const second = store.put(Buffer.from("hello"));

		expect(first).toBe(second);
		expect(first).toBe(hashContent(Buffer.from("hello")));
		expect(store.has(first)).toBe(true);
		expect(store.get(first).toString()).toBe("hello");
		expect(readdirSync(join(dir, first.slice(0, 2)))).toEqual([first.slice(2)]);
	});

	it("reports missing blobs", () => {
		const store = new BlobStore(dir);
		expect(store.has("ab".repeat(32))).toBe(false);
		expect(() => store.get("ab".repeat(32))).toThrow();
	});
});

describe("parseWorkEvent", () => {
	const base = { seq: 0, parent: null, time: "2026-11-13T00:00:00.000Z", agentId: "main" };

	it("accepts a well-formed event", () => {
		const event = { ...base, type: "tool.call", toolCallId: "t1", toolName: "bash", input: { command: "ls" } };
		expect(parseWorkEvent(event)).toEqual(event);
	});

	it("rejects unknown types, missing fields and values outside an enumeration", () => {
		expect(() => parseWorkEvent({ ...base, type: "nope" })).toThrow('unknown type "nope"');
		expect(() => parseWorkEvent({ ...base, type: "user.message" })).toThrow('"text" must be string');
		expect(() =>
			parseWorkEvent({
				...base,
				type: "policy.decision",
				toolCallId: "t",
				toolName: "bash",
				outcome: "maybe",
				via: "user",
				stage: "mode",
				reason: "",
				mode: "default",
			}),
		).toThrow('"outcome" must be allow | deny');
		expect(() => parseWorkEvent([])).toThrow("expected an object");
	});
});

describe("projections", () => {
	let seq = 0;
	const event = (body: WorkEventBody): WorkEvent => ({
		...body,
		seq: seq++,
		parent: null,
		time: "2026-11-13T00:00:00.000Z",
		agentId: "main",
	});
	const change = (path: string, before: string | null, after: string | null) =>
		event({ type: "file.change", path, toolCallId: "t", before, after });

	it("changedFiles keeps the first before and last after, and drops files that end unchanged", () => {
		const files = project(
			[change("a", null, "h1"), change("a", "h1", "h2"), change("b", "x", "y"), change("b", "y", "x")],
			changedFiles,
		);
		expect([...files.values()]).toEqual([{ path: "a", before: null, after: "h2", edits: 2 }]);
	});

	it("auditTrail lists decisions in order", () => {
		const decision = (outcome: "allow" | "deny") =>
			event({
				type: "policy.decision",
				toolCallId: "t",
				toolName: "bash",
				outcome,
				via: "rule",
				stage: "deny-rule",
				reason: "r",
				mode: "default",
			});
		const trail = project(
			[decision("allow"), event({ type: "user.message", text: "x" }), decision("deny")],
			auditTrail,
		);
		expect(trail.map((entry) => entry.outcome)).toEqual(["allow", "deny"]);
	});
});
