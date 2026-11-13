import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadPolicy, type PolicySources, projectPolicyPaths } from "../../../src/shiro/policy/config.ts";

let root: string;
let sources: PolicySources;

function put(path: string, content: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "policy-config-"));
	const project = join(root, "project");
	mkdirSync(join(project, ".git"), { recursive: true });
	mkdirSync(join(project, "packages", "ui"), { recursive: true });
	sources = {
		cwd: project,
		home: join(root, "home"),
		agentDir: join(root, "home", ".shiro", "agent"),
		projectConfigDir: ".shiro",
		managedDir: join(root, "managed"),
		includeProject: true,
		passThroughTools: ["codemode"],
	};
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

describe("projectPolicyPaths", () => {
	it("lists every project path the loader reads, so trust checks can cover them", () => {
		expect(projectPolicyPaths(".shiro")).toEqual([
			".shiro/policy.json",
			".shiro/policy.local.json",
			".claude/settings.json",
			".claude/settings.local.json",
			".shiro/rules",
			".codex/rules",
		]);
	});
});

describe("loadPolicy", () => {
	it("returns safe defaults when no file exists", () => {
		const { config, files, diagnostics } = loadPolicy(sources);
		expect(config).toMatchObject({
			mode: "default",
			allow: [],
			ask: [],
			deny: [],
			commandRules: [],
			workspaceRoots: [sources.cwd],
			projectRoot: sources.cwd,
			disableBypassPermissions: false,
			passThroughTools: ["codemode"],
		});
		expect(files).toEqual([]);
		expect(diagnostics).toEqual([]);
	});

	it("merges Shiro files, Claude Code settings and rules files across layers", () => {
		put(join(sources.agentDir, "policy.json"), { defaultMode: "acceptEdits", allow: ["Bash(npm test:*)"] });
		put(join(sources.home, ".claude", "settings.json"), { permissions: { deny: ["Read(.env)"] }, model: "ignored" });
		put(join(sources.cwd, ".shiro", "policy.json"), { defaultMode: "plan", ask: ["Bash(git push:*)"] });
		put(join(sources.cwd, ".claude", "settings.local.json"), { permissions: { allow: ["Edit(/docs/**)"] } });
		put(join(sources.agentDir, "rules", "default.rules"), 'prefix_rule(pattern=["cargo", "test"])');
		put(
			join(sources.cwd, ".codex", "rules", "team.rules"),
			'prefix_rule(pattern=["git", "push", "--force"], decision="forbidden")',
		);

		const { config, files, diagnostics } = loadPolicy(sources);
		expect(diagnostics).toEqual([]);
		expect(config.mode).toBe("plan");
		expect(config.allow.map((rule) => rule.text)).toEqual(["Bash(npm test:*)", "Edit(/docs/**)"]);
		expect(config.ask.map((rule) => rule.text)).toEqual(["Bash(git push:*)"]);
		expect(config.deny.map((rule) => rule.text)).toEqual(["Read(.env)"]);
		expect(config.commandRules.map((rule) => rule.decision)).toEqual(["allow", "forbidden"]);
		expect(files).toHaveLength(6);
		expect(config.allow[0].source).toBe(join(sources.agentDir, "policy.json"));
	});

	it("ignores every project file when the project is not trusted", () => {
		put(join(sources.cwd, ".shiro", "policy.json"), { allow: ["Bash"] });
		put(join(sources.cwd, ".codex", "rules", "team.rules"), 'prefix_rule(pattern=["rm"])');
		const { config, files } = loadPolicy({ ...sources, includeProject: false });
		expect(config.allow).toEqual([]);
		expect(config.commandRules).toEqual([]);
		expect(files).toEqual([]);
	});

	it("does not let a project file switch approvals off", () => {
		put(join(sources.cwd, ".shiro", "policy.json"), { defaultMode: "bypassPermissions" });
		const { config, diagnostics } = loadPolicy(sources);
		expect(config.mode).toBe("default");
		expect(diagnostics).toEqual([
			`${join(sources.cwd, ".shiro", "policy.json")}: a project file cannot set defaultMode to bypassPermissions; ignored`,
		]);
	});

	it("lets managed policy set the mode over everything and disable bypass", () => {
		put(join(sources.agentDir, "policy.json"), { defaultMode: "bypassPermissions" });
		put(join(sources.cwd, ".shiro", "policy.json"), { defaultMode: "acceptEdits" });
		put(join(sources.managedDir, "policy.json"), {
			defaultMode: "default",
			disableBypassPermissions: true,
			deny: ["Bash(curl:*)"],
		});
		const { config } = loadPolicy(sources);
		expect(config.mode).toBe("default");
		expect(config.disableBypassPermissions).toBe(true);
		expect(config.deny.map((rule) => rule.text)).toEqual(["Bash(curl:*)"]);
	});

	it("ignores disableBypassPermissions outside managed policy", () => {
		put(join(sources.agentDir, "policy.json"), { disableBypassPermissions: true });
		expect(loadPolicy(sources).config.disableBypassPermissions).toBe(false);
	});

	it("adds extra directories to the workspace, resolved against the file's own base", () => {
		put(join(sources.agentDir, "policy.json"), { additionalDirectories: ["~/notes", "/opt/sdk"] });
		put(join(sources.cwd, ".shiro", "policy.json"), { additionalDirectories: ["../shared"] });
		expect(loadPolicy(sources).config.workspaceRoots).toEqual([
			sources.cwd,
			join(sources.home, "notes"),
			"/opt/sdk",
			join(root, "shared"),
		]);
	});

	it("treats the working directory as the project, not an enclosing repository", () => {
		const cwd = join(sources.cwd, "packages", "ui");
		put(join(sources.cwd, ".shiro", "policy.json"), { allow: ["Bash(npm test:*)"] });
		put(join(cwd, ".shiro", "policy.json"), { allow: ["Bash(npm run build)"] });
		const { config } = loadPolicy({ ...sources, cwd });
		expect(config.allow.map((rule) => rule.text)).toEqual(["Bash(npm run build)"]);
		expect(config.projectRoot).toBe(cwd);
		expect(config.workspaceRoots).toEqual([cwd]);
	});

	it("reports broken files and bad entries without failing the load", () => {
		const user = join(sources.agentDir, "policy.json");
		const project = join(sources.cwd, ".shiro", "policy.json");
		const rules = join(sources.agentDir, "rules", "bad.rules");
		put(user, "{ not json");
		put(project, { defaultMode: "auto", allow: ["Bash(npm", "Bash(npm test:*)"], deny: "Read" });
		put(join(sources.cwd, ".shiro", "policy.local.json"), ["a list"]);
		put(rules, 'prefix_rule(pattern=["a"], decision="maybe")');

		const { config, diagnostics } = loadPolicy(sources);
		expect(config.mode).toBe("default");
		expect(config.allow.map((rule) => rule.text)).toEqual(["Bash(npm test:*)"]);
		expect(diagnostics).toHaveLength(6);
		expect(diagnostics[0]).toContain(`${user}: `);
		expect(diagnostics[1]).toBe(`${rules}:1: "decision" must be "allow", "prompt" or "forbidden"`);
		expect(diagnostics[2]).toContain("Invalid permission rule");
		expect(diagnostics[3]).toBe(`${project}: "deny" must be a list of strings`);
		expect(diagnostics[4]).toBe(`${project}: defaultMode "auto" is not supported here and was ignored`);
		expect(diagnostics[5]).toBe(`${join(sources.cwd, ".shiro", "policy.local.json")}: expected a JSON object`);
	});
});
