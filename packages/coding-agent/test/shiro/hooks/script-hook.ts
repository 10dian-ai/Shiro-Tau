// Test helper: writes a small Node script and returns a hook handler that runs it.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { type HookEventName, type HookHandler, type HookLayer, hookId } from "../../../src/shiro/hooks/config.ts";

export interface ScriptHookOptions {
	matcher?: string;
	layer?: HookLayer;
	timeoutSeconds?: number;
}

let counter = 0;

/**
 * A handler whose command runs `body` as the body of an async function. The script gets `event`
 * (the parsed stdin payload) and `fs`; whatever it writes to stdout or stderr is the hook's output.
 */
export function scriptHook(
	dir: string,
	event: HookEventName,
	body: string,
	options: ScriptHookOptions = {},
): HookHandler {
	const file = join(dir, `hook-${counter++}.mjs`);
	writeFileSync(
		file,
		`import fs from "node:fs";\nconst event = JSON.parse(fs.readFileSync(0, "utf8"));\nawait (async () => {\n${body}\n})();\n`,
	);
	const command = `"${process.execPath}" "${file}"`;
	return {
		id: hookId(event, options.matcher, command),
		event,
		...(options.matcher === undefined ? {} : { matcher: options.matcher }),
		command,
		timeoutSeconds: options.timeoutSeconds ?? 20,
		source: "test",
		layer: options.layer ?? "user",
	};
}
