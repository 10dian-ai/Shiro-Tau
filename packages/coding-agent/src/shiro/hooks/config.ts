// Loads hook definitions from disk: Shiro's hooks.json, Claude Code settings and Codex hooks.json.

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** The lifecycle points this build runs hooks at. */
export type HookEventName = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop" | "SessionStart" | "SessionEnd";

export const HOOK_EVENTS: readonly HookEventName[] = [
	"PreToolUse",
	"PostToolUse",
	"UserPromptSubmit",
	"Stop",
	"SessionStart",
	"SessionEnd",
];

/** Who wrote a hook. Project hooks come with a repository and must be reviewed before they run. */
export type HookLayer = "managed" | "user" | "project";

/** One command to run at one event. */
export interface HookHandler {
	/** Hash of event, matcher and command: changing any of them makes it a different hook. */
	id: string;
	event: HookEventName;
	/** Regular expression matched against the whole tool name (or session start source); undefined matches everything. */
	matcher?: string;
	command: string;
	timeoutSeconds: number;
	statusMessage?: string;
	/** The file it was read from. */
	source: string;
	layer: HookLayer;
}

/** Where to look. Project files are only read when `includeProject` is set, which callers tie to project trust. */
export interface HookSources {
	home: string;
	/** The user's agent directory, e.g. ~/.shiro/agent. */
	agentDir: string;
	/** The project: the directory the agent was started in. */
	projectDir: string;
	/** Name of the per-project config directory, e.g. ".shiro". */
	projectConfigDir: string;
	/** Directory holding the administrator's hooks.json. */
	managedDir: string;
	includeProject: boolean;
}

export interface LoadedHooks {
	handlers: HookHandler[];
	/** Files that were found and read, in load order. */
	files: string[];
	/** Problems worth showing the user. Loading never throws for them. */
	diagnostics: string[];
}

/** Seconds a hook may run when it sets no timeout of its own. */
export const DEFAULT_HOOK_TIMEOUT_SECONDS = 60;

/**
 * Read every hook file that applies. All files use the shape Claude Code and Codex share:
 * `{ "hooks": { "<Event>": [ { "matcher": "...", "hooks": [ { "type": "command", "command": "..." } ] } ] } }`.
 * The same command registered twice for one event and matcher is kept once.
 */
export function loadHooks(sources: HookSources): LoadedHooks {
	const loaded: LoadedHooks = { handlers: [], files: [], diagnostics: [] };
	readHookFile(loaded, join(sources.managedDir, "hooks.json"), "managed");
	readHookFile(loaded, join(sources.agentDir, "hooks.json"), "user");
	readHookFile(loaded, join(sources.home, ".claude", "settings.json"), "user");
	readHookFile(loaded, join(sources.home, ".codex", "hooks.json"), "user");
	if (sources.includeProject) {
		for (const file of projectHookPaths(sources.projectConfigDir))
			readHookFile(loaded, join(sources.projectDir, file), "project");
	}
	return loaded;
}

/**
 * Files, relative to a project, that this loader reads when the project is trusted. Whoever decides
 * project trust must treat a project holding any of them as one that needs a decision.
 */
export function projectHookPaths(projectConfigDir: string): string[] {
	return [
		`${projectConfigDir}/hooks.json`,
		".claude/settings.json",
		".claude/settings.local.json",
		".codex/hooks.json",
	];
}

/** The identity of a hook: what the trust store remembers and what deduplication compares. */
export function hookId(event: HookEventName, matcher: string | undefined, command: string): string {
	return createHash("sha256")
		.update(`${event}\0${matcher ?? ""}\0${command}`)
		.digest("hex");
}

function readHookFile(loaded: LoadedHooks, file: string, layer: HookLayer): void {
	if (!existsSync(file)) return;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(file, "utf8"));
	} catch (error) {
		loaded.files.push(file);
		loaded.diagnostics.push(`${file}: ${(error as Error).message}`);
		return;
	}
	// File contents are untrusted input: every field is checked before use.
	if (!isRecord(parsed) || parsed.hooks === undefined) return;
	loaded.files.push(file);
	if (!isRecord(parsed.hooks)) {
		loaded.diagnostics.push(`${file}: "hooks" must be an object keyed by event name`);
		return;
	}
	for (const [eventName, groups] of Object.entries(parsed.hooks)) {
		const event = HOOK_EVENTS.find((candidate) => candidate === eventName);
		if (!event) {
			loaded.diagnostics.push(
				`${file}: hooks for the event ${eventName} are not run by this version and were skipped`,
			);
			continue;
		}
		if (!Array.isArray(groups)) {
			loaded.diagnostics.push(`${file}: ${eventName} must be a list`);
			continue;
		}
		for (const group of groups) readGroup(loaded, file, layer, event, group);
	}
}

function readGroup(loaded: LoadedHooks, file: string, layer: HookLayer, event: HookEventName, group: unknown): void {
	if (!isRecord(group) || !Array.isArray(group.hooks)) {
		loaded.diagnostics.push(`${file}: every ${event} entry needs a "hooks" list`);
		return;
	}
	if (group.matcher !== undefined && typeof group.matcher !== "string") {
		loaded.diagnostics.push(`${file}: a ${event} matcher must be a string`);
		return;
	}
	const matcher =
		group.matcher === undefined || group.matcher === "" || group.matcher === "*" ? undefined : group.matcher;
	if (matcher !== undefined) {
		try {
			new RegExp(matcher);
		} catch {
			loaded.diagnostics.push(
				`${file}: ${event} matcher ${JSON.stringify(matcher)} is not a valid regular expression`,
			);
			return;
		}
	}
	for (const hook of group.hooks) {
		if (!isRecord(hook) || hook.type !== "command") {
			const type = isRecord(hook) && typeof hook.type === "string" ? hook.type : "unknown";
			loaded.diagnostics.push(`${file}: ${event} hook of type "${type}" is not run by this version and was skipped`);
			continue;
		}
		if (typeof hook.command !== "string" || hook.command.trim() === "") {
			loaded.diagnostics.push(`${file}: a ${event} command hook needs a non-empty "command"`);
			continue;
		}
		const timeoutSeconds =
			typeof hook.timeout === "number" && hook.timeout > 0 ? hook.timeout : DEFAULT_HOOK_TIMEOUT_SECONDS;
		const id = hookId(event, matcher, hook.command);
		if (loaded.handlers.some((handler) => handler.id === id)) continue;
		loaded.handlers.push({
			id,
			event,
			...(matcher === undefined ? {} : { matcher }),
			command: hook.command,
			timeoutSeconds,
			...(typeof hook.statusMessage === "string" ? { statusMessage: hook.statusMessage } : {}),
			source: file,
			layer,
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
