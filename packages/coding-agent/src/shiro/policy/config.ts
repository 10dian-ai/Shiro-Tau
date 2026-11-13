// Loads policy from disk: Shiro's own files, Claude Code settings and Codex rules files, layer by layer.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { type PrefixRule, parseRulesFile } from "./command-rules.ts";
import { PERMISSION_MODES, type PermissionMode, type PolicyConfig } from "./engine.ts";
import { type PermissionRule, parsePermissionRule } from "./permission-rules.ts";

/** Where to look. Project files are only read when `includeProject` is set, which callers tie to project trust. */
export interface PolicySources {
	/** The directory the agent was started in, as a real path. It is the project and the workspace. */
	cwd: string;
	home: string;
	/** The user's agent directory, e.g. ~/.shiro/agent. */
	agentDir: string;
	/** Name of the per-project config directory, e.g. ".shiro". */
	projectConfigDir: string;
	/** Directory holding the administrator's policy.json. */
	managedDir: string;
	includeProject: boolean;
	passThroughTools: string[];
}

export interface LoadedPolicy {
	config: PolicyConfig;
	/** Files that were found and read, in load order. */
	files: string[];
	/** Problems worth showing the user: bad JSON, invalid rules, ignored settings. Loading never throws for them. */
	diagnostics: string[];
}

/** Which layer a file belongs to; only "managed" may lock settings and "project" may not loosen the mode. */
type Layer = "managed" | "user" | "project";

/**
 * Read every policy file that applies and merge them. Rules accumulate across layers. The mode is
 * taken from the most specific layer that sets one (project over user), and managed policy wins
 * over both.
 */
export function loadPolicy(sources: PolicySources): LoadedPolicy {
	const state: MergeState = {
		home: sources.home,
		mode: undefined,
		managedMode: undefined,
		allow: [],
		ask: [],
		deny: [],
		commandRules: [],
		extraRoots: [],
		disableBypassPermissions: false,
		files: [],
		diagnostics: [],
	};
	const project = sources.cwd;

	readSettings(state, join(sources.agentDir, "policy.json"), "user", sources.home);
	readSettings(state, join(sources.home, ".claude", "settings.json"), "user", sources.home);
	readRulesDirectory(state, join(sources.agentDir, "rules"));
	readRulesDirectory(state, join(sources.home, ".codex", "rules"));
	if (sources.includeProject) {
		for (const file of projectSettingsFiles(sources.projectConfigDir)) {
			readSettings(state, join(project, file), "project", project);
		}
		readRulesDirectory(state, join(project, sources.projectConfigDir, "rules"));
		readRulesDirectory(state, join(project, ".codex", "rules"));
	}
	readSettings(state, join(sources.managedDir, "policy.json"), "managed", sources.managedDir);

	return {
		config: {
			mode: state.managedMode ?? state.mode ?? "default",
			allow: state.allow,
			ask: state.ask,
			deny: state.deny,
			commandRules: state.commandRules,
			workspaceRoots: [...new Set([project, ...state.extraRoots])],
			projectRoot: project,
			home: sources.home,
			disableBypassPermissions: state.disableBypassPermissions,
			passThroughTools: sources.passThroughTools,
		},
		files: state.files,
		diagnostics: state.diagnostics,
	};
}

/**
 * Files and directories, relative to a project, that this loader reads when the project is trusted.
 * Whoever decides project trust must treat a project holding any of them as one that needs a decision.
 */
export function projectPolicyPaths(projectConfigDir: string): string[] {
	return [...projectSettingsFiles(projectConfigDir), `${projectConfigDir}/rules`, ".codex/rules"];
}

function projectSettingsFiles(projectConfigDir: string): string[] {
	return [
		`${projectConfigDir}/policy.json`,
		`${projectConfigDir}/policy.local.json`,
		".claude/settings.json",
		".claude/settings.local.json",
	];
}

interface MergeState {
	home: string;
	mode: PermissionMode | undefined;
	managedMode: PermissionMode | undefined;
	allow: PermissionRule[];
	ask: PermissionRule[];
	deny: PermissionRule[];
	commandRules: PrefixRule[];
	extraRoots: string[];
	disableBypassPermissions: boolean;
	files: string[];
	diagnostics: string[];
}

/**
 * Merge one settings file. Both shapes are accepted: Shiro's flat `{ defaultMode, allow, ask, deny,
 * additionalDirectories }` and Claude Code's, which nests the same keys under `permissions`.
 */
function readSettings(state: MergeState, file: string, layer: Layer, baseDirectory: string): void {
	const parsed = readJson(state, file);
	if (parsed === undefined) return;
	// File contents are untrusted input: every field is checked before use.
	if (!isRecord(parsed)) {
		state.diagnostics.push(`${file}: expected a JSON object`);
		return;
	}
	const settings = isRecord(parsed.permissions) ? parsed.permissions : parsed;

	for (const list of ["allow", "ask", "deny"] as const) {
		for (const text of stringList(state, file, list, settings[list])) {
			try {
				state[list].push(parsePermissionRule(text, file));
			} catch (error) {
				state.diagnostics.push(`${file}: ${(error as Error).message}`);
			}
		}
	}
	for (const directory of stringList(state, file, "additionalDirectories", settings.additionalDirectories)) {
		const expanded =
			directory === "~" || directory.startsWith("~/") ? join(state.home, directory.slice(1)) : directory;
		state.extraRoots.push(isAbsolute(expanded) ? resolve(expanded) : resolve(baseDirectory, expanded));
	}
	readMode(state, file, layer, settings.defaultMode);
	if (
		layer === "managed" &&
		(settings.disableBypassPermissions === true || settings.disableBypassPermissionsMode === "disable")
	) {
		state.disableBypassPermissions = true;
	}
}

function readMode(state: MergeState, file: string, layer: Layer, value: unknown): void {
	if (value === undefined) return;
	const mode = PERMISSION_MODES.find((candidate) => candidate === value);
	if (!mode) {
		state.diagnostics.push(`${file}: defaultMode ${JSON.stringify(value)} is not supported here and was ignored`);
	} else if (layer === "project" && mode === "bypassPermissions") {
		// A repository must not be able to switch off approvals for whoever opens it.
		state.diagnostics.push(`${file}: a project file cannot set defaultMode to bypassPermissions; ignored`);
	} else if (layer === "managed") {
		state.managedMode = mode;
	} else {
		state.mode = mode;
	}
}

function readRulesDirectory(state: MergeState, directory: string): void {
	if (!existsSync(directory)) return;
	for (const name of readdirSync(directory).sort()) {
		if (!name.endsWith(".rules")) continue;
		const file = join(directory, name);
		const parsed = parseRulesFile(readFileSync(file, "utf8"), file);
		state.files.push(file);
		state.commandRules.push(...parsed.rules);
		state.diagnostics.push(...parsed.errors);
	}
}

function readJson(state: MergeState, file: string): unknown {
	if (!existsSync(file)) return undefined;
	state.files.push(file);
	try {
		return JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		state.diagnostics.push(`${file}: ${(error as Error).message}`);
		return undefined;
	}
}

function stringList(state: MergeState, file: string, key: string, value: unknown): string[] {
	if (value === undefined) return [];
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) return value;
	state.diagnostics.push(`${file}: "${key}" must be a list of strings`);
	return [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
