// Short, human-readable descriptions of tool calls for approval prompts, the audit view and the work log.

/** Longest string kept per input field in the work log; file contents live in the blob store instead. */
const LOGGED_FIELD_LIMIT = 2000;

/** One or a few lines saying what the call would do. */
export function describeToolCall(toolName: string, input: Record<string, unknown>): string {
	const path = typeof input.path === "string" ? input.path : ".";
	switch (toolName) {
		case "bash":
		case "powershell":
			return `$ ${clip(typeof input.command === "string" ? input.command : "", 600)}`;
		case "edit":
			return `edit ${path} (${Array.isArray(input.edits) ? input.edits.length : 1} replacement(s))`;
		case "write":
			return `write ${path} (${typeof input.content === "string" ? input.content.length : 0} characters)`;
		case "read":
		case "ls":
			return `${toolName} ${path}`;
		case "grep":
		case "find":
			return `${toolName} ${JSON.stringify(input.pattern ?? "")} in ${path}`;
		default:
			return `${toolName} ${clip(JSON.stringify(input), 300)}`;
	}
}

/** The first line of `text`, shortened to `limit` characters: a label for a checkpoint or list row. */
export function firstLine(text: string, limit: number): string {
	const line = text.trim().split("\n", 1)[0] ?? "";
	return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

/** A copy of tool input that is safe to keep in the log: long strings are cut and say how much was dropped. */
export function boundedInput(input: Record<string, unknown>): Record<string, unknown> {
	return bound(input) as Record<string, unknown>;
}

function bound(value: unknown): unknown {
	if (typeof value === "string") return clip(value, LOGGED_FIELD_LIMIT);
	if (Array.isArray(value)) return value.map(bound);
	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bound(entry)]));
	}
	return value;
}

function clip(text: string, limit: number): string {
	return text.length > limit ? `${text.slice(0, limit)}… [+${text.length - limit} characters]` : text;
}
