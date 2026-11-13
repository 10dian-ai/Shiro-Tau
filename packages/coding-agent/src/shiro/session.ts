// One session's Shiro state: its work log and file history, and the policy and hooks that apply to it.

import { existsSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "../config.ts";
import type { ExtensionContext } from "../core/extensions/types.ts";
import { HookDispatcher, type HookHandler, type HookSession, HookTrustStore, loadHooks } from "./hooks/index.ts";
import { canonicalPath, loadPolicy, type PermissionMode, type PolicyConfig, PolicyEngine } from "./policy/index.ts";
import { BlobStore, FileHistory, WorkLog, WorkLogError } from "./workgraph/index.ts";

export interface ShiroSessionOptions {
	/** The user's agent directory; work logs, hook reviews and user-level policy live under it. */
	agentDir: string;
	/** Directory of the administrator's policy.json and hooks.json. */
	managedDir: string;
	/** The user's home directory, where Claude Code and Codex keep their settings. */
	home: string;
	/** Mode chosen on the command line or with /permissions. It wins over every file's default; managed policy can still forbid bypassPermissions. */
	mode: PermissionMode | undefined;
}

/** Everything Shiro keeps for one open session. */
export interface ShiroSession {
	sessionId: string;
	/** The working directory as a real path: the project, and the root of the workspace. */
	cwd: string;
	log: WorkLog;
	files: FileHistory;
	policy: PolicyEngine;
	/** The merged policy the engine was built from, for display. */
	policyConfig: PolicyConfig;
	hooks: HookDispatcher;
	hookHandlers: readonly HookHandler[];
	hookTrust: HookTrustStore;
	/** Policy and hook files that were read, in load order. */
	loadedFiles: string[];
	/** Problems found while opening: bad config entries, an unreadable log, a refused mode. */
	diagnostics: string[];
	/** Set for sessions that are not saved: the directory to remove when the session closes. */
	temporaryDir: string | undefined;
}

/**
 * Tools that only route to other tools: the script runner and the tool search. Each call they make
 * is judged on its own. Named here, not imported, so this module does not load those tools.
 */
export const PASS_THROUGH_TOOLS = ["codemode", "tool_search"];

/** Where the administrator's policy lives on this platform. Users cannot redirect it. */
export function defaultManagedDir(): string {
	return process.platform === "win32"
		? join(process.env.ProgramData ?? "C:\\ProgramData", "shiro-tau")
		: "/etc/shiro-tau";
}

/**
 * Open the state for the session `ctx` belongs to. Project-level policy and hooks are only read
 * when the project is trusted. A work log that cannot be read is set aside and a new one started,
 * so a damaged file never stops the agent from working.
 */
export function openShiroSession(ctx: ExtensionContext, options: ShiroSessionOptions): ShiroSession {
	const sessionId = ctx.sessionManager.getSessionId();
	const cwd = canonicalPath(ctx.cwd);
	const { home } = options;
	const includeProject = ctx.isProjectTrusted();
	const diagnostics: string[] = [];

	// A session that is not saved gets a throwaway work log: rewind works while it runs, nothing is left behind.
	const temporaryDir = ctx.sessionManager.getSessionFile()
		? undefined
		: mkdtempSync(join(tmpdir(), "shiro-workgraph-"));
	const storageDir = temporaryDir ?? join(options.agentDir, "workgraph", sessionId);
	const log = openWorkLog(join(storageDir, "log.jsonl"), { sessionId, cwd }, diagnostics);
	const files = new FileHistory(log, new BlobStore(join(storageDir, "blobs")));

	const policyFiles = loadPolicy({
		cwd,
		home,
		agentDir: options.agentDir,
		projectConfigDir: CONFIG_DIR_NAME,
		managedDir: options.managedDir,
		includeProject,
		passThroughTools: PASS_THROUGH_TOOLS,
	});
	const policy = new PolicyEngine(policyFiles.config);
	if (options.mode) {
		try {
			policy.setMode(options.mode);
		} catch (error) {
			diagnostics.push((error as Error).message);
		}
	}

	const hookFiles = loadHooks({
		home,
		agentDir: options.agentDir,
		projectDir: cwd,
		projectConfigDir: CONFIG_DIR_NAME,
		managedDir: options.managedDir,
		includeProject,
	});
	const hookTrust = new HookTrustStore(join(options.agentDir, "hook-trust.json"));
	const hooks = new HookDispatcher({
		handlers: hookFiles.handlers,
		trust: hookTrust,
		env: process.env,
		onRun: ({ handler, status, exitCode, durationMs }) => {
			log.append({
				type: "hook.run",
				hookEvent: handler.event,
				command: handler.command,
				status,
				exitCode,
				durationMs,
			});
		},
	});

	return {
		sessionId,
		cwd,
		log,
		files,
		policy,
		policyConfig: policyFiles.config,
		hooks,
		hookHandlers: hookFiles.handlers,
		hookTrust,
		loadedFiles: [...new Set([...policyFiles.files, ...hookFiles.files])],
		diagnostics: [...diagnostics, ...policyFiles.diagnostics, ...hookFiles.diagnostics],
		temporaryDir,
	};
}

/** Release what the session holds on disk beyond its saved log. */
export function closeShiroSession(session: ShiroSession): void {
	if (session.temporaryDir) rmSync(session.temporaryDir, { recursive: true, force: true });
}

/** The session facts hooks receive. */
export function hookSessionOf(session: ShiroSession, ctx: ExtensionContext): HookSession {
	return {
		sessionId: session.sessionId,
		transcriptPath: ctx.sessionManager.getSessionFile(),
		cwd: session.cwd,
		projectDir: session.cwd,
		permissionMode: session.policy.mode,
	};
}

function openWorkLog(path: string, init: { sessionId: string; cwd: string }, diagnostics: string[]): WorkLog {
	try {
		return WorkLog.openOrCreate(path, init);
	} catch (error) {
		if (!(error instanceof WorkLogError) || !existsSync(path)) throw error;
		const setAside = `${path}.unreadable-${Date.now()}`;
		renameSync(path, setAside);
		diagnostics.push(
			`The work log of this session could not be read (${error.message}). It was moved to ${setAside} and a new one started; earlier checkpoints are not available.`,
		);
		return WorkLog.create(path, init);
	}
}
