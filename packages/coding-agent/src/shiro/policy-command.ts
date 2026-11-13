// `shiro policy`: show the permission policy that applies in a directory, or ask what it would decide for one call.

import { homedir } from "node:os";
import chalk from "chalk";
import { APP_NAME, CONFIG_DIR_NAME } from "../config.ts";
import { ProjectTrustStore } from "../core/trust-manager.ts";
import { describeToolCall } from "./describe-call.ts";
import {
	canonicalPath,
	type LoadedPolicy,
	loadPolicy,
	PERMISSION_MODES,
	PolicyEngine,
	toolKind,
} from "./policy/index.ts";
import { defaultManagedDir, PASS_THROUGH_TOOLS } from "./session.ts";

export interface PolicyCommandOptions {
	cwd: string;
	agentDir: string;
	/** Directory of the administrator's policy. Defaults to the system location. */
	managedDir?: string;
	/** The user's home directory. Defaults to the operating system's. */
	home?: string;
}

const HELP = `${chalk.bold("Usage:")}
  ${APP_NAME} policy show [--json]
  ${APP_NAME} policy check <tool> <input> [--mode <mode>] [--json]

Shows the permission policy for the current directory without starting a session.
Reads ~/${CONFIG_DIR_NAME}/agent/policy.json, ~/.claude/settings.json and rules files, plus the
project's own files when the project is trusted.

Commands:
  show                    Mode, rules, files read and problems found
  check <tool> <input>    What would happen to one call: allow, ask or deny, and why

For check, <input> is the command for bash, the path for file tools (read, edit, write, grep,
find, ls) and a JSON object for any other tool.

Options:
  --mode <mode>           Decide as if this mode were active: ${PERMISSION_MODES.join(", ")}
  --json                  Machine-readable output

Examples:
  ${APP_NAME} policy check bash "git push --force"
  ${APP_NAME} policy check edit src/index.ts --mode acceptEdits`;

/** Run the command with the arguments after `policy`. Returns the process exit code: 0, or 1 for a usage error. */
export function runPolicyCommand(args: string[], options: PolicyCommandOptions): number {
	const json = args.includes("--json");
	const modeIndex = args.indexOf("--mode");
	const modeText = modeIndex === -1 ? undefined : args[modeIndex + 1];
	const positional = args.filter(
		(arg, index) => arg !== "--json" && index !== modeIndex && (modeIndex === -1 || index !== modeIndex + 1),
	);
	const [command = "show", toolName, inputText, ...extra] = positional;
	const mode = PERMISSION_MODES.find((candidate) => candidate === modeText);

	if (command === "help" || args.includes("--help") || args.includes("-h")) {
		console.log(HELP);
		return 0;
	}
	if (modeIndex !== -1 && !mode)
		return usageError(`Unknown mode "${modeText ?? ""}". Modes: ${PERMISSION_MODES.join(", ")}.`);

	const cwd = canonicalPath(options.cwd);
	const loaded = loadPolicy({
		cwd,
		home: options.home ?? homedir(),
		agentDir: options.agentDir,
		projectConfigDir: CONFIG_DIR_NAME,
		managedDir: options.managedDir ?? defaultManagedDir(),
		includeProject: new ProjectTrustStore(options.agentDir).get(options.cwd) === true,
		passThroughTools: PASS_THROUGH_TOOLS,
	});
	const engine = new PolicyEngine(loaded.config);
	if (mode) {
		try {
			engine.setMode(mode);
		} catch (error) {
			return usageError((error as Error).message);
		}
	}

	if (command === "show" && toolName === undefined) {
		console.log(json ? JSON.stringify({ mode: engine.mode, ...loaded }, null, 2) : formatPolicy(loaded, engine.mode));
		return 0;
	}
	if (command !== "check" || toolName === undefined || inputText === undefined || extra.length > 0) {
		return usageError(`Expected "${APP_NAME} policy show" or "${APP_NAME} policy check <tool> <input>".`);
	}

	const input = parseInput(toolName, inputText);
	if (!input) return usageError(`The input for ${toolName} must be a JSON object, for example '{"query":"x"}'.`);
	const decision = engine.evaluate({ toolName, input, cwd });
	if (json) {
		console.log(JSON.stringify({ tool: toolName, input, mode: engine.mode, ...decision }, null, 2));
	} else {
		const color = decision.outcome === "allow" ? chalk.green : decision.outcome === "deny" ? chalk.red : chalk.yellow;
		console.log(`${color(decision.outcome)}  ${describeToolCall(toolName, input)}`);
		console.log(`  ${decision.reason} (stage: ${decision.stage}, mode: ${engine.mode})`);
	}
	return 0;
}

/** The tool input a short command-line argument stands for; undefined when a JSON object was needed and not given. */
function parseInput(toolName: string, text: string): Record<string, unknown> | undefined {
	const kind = toolKind(toolName);
	if (kind === "execute") return { command: text };
	if (kind === "read" || kind === "edit") return { path: text };
	try {
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function formatPolicy(loaded: LoadedPolicy, mode: string): string {
	const { config } = loaded;
	const section = (title: string, lines: string[]): string[] =>
		lines.length === 0 ? [] : [chalk.bold(title), ...lines.map((line) => `  ${line}`)];
	return [
		`${chalk.bold("Mode")}  ${mode}${config.disableBypassPermissions ? "  (bypassPermissions is disabled by managed policy)" : ""}`,
		`${chalk.bold("Workspace")}  ${config.workspaceRoots.join(", ")}`,
		...section(
			"Deny",
			config.deny.map((rule) => `${rule.text}  (${rule.source})`),
		),
		...section(
			"Ask",
			config.ask.map((rule) => `${rule.text}  (${rule.source})`),
		),
		...section(
			"Allow",
			config.allow.map((rule) => `${rule.text}  (${rule.source})`),
		),
		...section(
			"Command rules",
			config.commandRules.map((rule) => `${rule.decision}  ${JSON.stringify(rule.pattern)}  (${rule.source})`),
		),
		...section("Files read", loaded.files),
		...section("Problems", loaded.diagnostics),
		...(loaded.files.length === 0 ? ["No policy files found: the defaults of the mode apply."] : []),
	].join("\n");
}

function usageError(message: string): number {
	console.error(chalk.red(message));
	console.error(`Run "${APP_NAME} policy help" for usage.`);
	return 1;
}
