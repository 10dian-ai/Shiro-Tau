import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CONFIG_DIR_NAME } from "../../src/config.ts";
import { hasTrustRequiringProjectResources } from "../../src/core/trust-manager.ts";
import { projectHookPaths } from "../../src/shiro/hooks/config.ts";
import { projectPolicyPaths } from "../../src/shiro/policy/config.ts";

let project: string;

beforeEach(() => {
	project = realpathSync(mkdtempSync(join(tmpdir(), "shiro-trust-")));
});

afterEach(() => {
	rmSync(project, { recursive: true, force: true });
});

describe("project trust and the files a project can bring", () => {
	it("needs no trust decision for a project without policy or hook files", () => {
		writeFileSync(join(project, "README.md"), "hello");
		expect(hasTrustRequiringProjectResources(project)).toBe(false);
	});

	// A project that could loosen permissions or run hooks without the user ever being asked would
	// defeat both, so every path the loaders read must make the project one that needs a decision.
	it.each([...new Set([...projectPolicyPaths(CONFIG_DIR_NAME), ...projectHookPaths(CONFIG_DIR_NAME)])])(
		"needs a trust decision when the project holds %s",
		(path) => {
			const target = join(project, path);
			mkdirSync(dirname(target), { recursive: true });
			if (path.endsWith("rules")) mkdirSync(target);
			else writeFileSync(target, "{}");
			expect(hasTrustRequiringProjectResources(project)).toBe(true);
		},
	);
});
