import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalPath } from "../../../src/shiro/policy/canonical-path.ts";
import { isReadOnlyCommand } from "../../../src/shiro/policy/read-only.ts";

let root: string;

beforeEach(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "policy-canonical-")));
	mkdirSync(join(root, "workspace"));
	mkdirSync(join(root, "outside"));
	writeFileSync(join(root, "outside", "secret"), "s");
	symlinkSync(join(root, "outside"), join(root, "workspace", "link"));
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("canonicalPath", () => {
	it("resolves links in existing paths", () => {
		expect(canonicalPath(join(root, "workspace", "link", "secret"))).toBe(join(root, "outside", "secret"));
	});

	it("resolves the existing part and keeps the rest for paths that do not exist yet", () => {
		expect(canonicalPath(join(root, "workspace", "link", "new", "file.txt"))).toBe(
			join(root, "outside", "new", "file.txt"),
		);
		expect(canonicalPath(join(root, "workspace", "new.txt"))).toBe(join(root, "workspace", "new.txt"));
	});
});

describe("isReadOnlyCommand with links", () => {
	it("does not treat a read through a link that leaves the workspace as read-only", () => {
		const workspace = join(root, "workspace");
		const reads = (argv: string[]): boolean =>
			isReadOnlyCommand({ argv, writeTargets: [] }, workspace, root, [workspace]);
		expect(reads(["cat", "link/secret"])).toBe(false);
		expect(reads(["ls", "link"])).toBe(false);
		expect(reads(["cat", "plain.txt"])).toBe(true);
	});
});
