// The work graph's event vocabulary, and validation of events read back from disk (a wire boundary).

/** Version of the on-disk log format. A log with a higher version was written by a newer Shiro. */
export const WORKGRAPH_FORMAT_VERSION = 1;

/** First line of a work log file. */
export interface WorkLogHeader {
	type: "workgraph";
	version: number;
	sessionId: string;
	/** Directory that relative paths in `file.change` events are resolved against. */
	cwd: string;
	createdAt: string;
}

/** Who settled a permission decision. `no-ui` means approval was needed but nobody could be asked. */
export type DecisionVia = "hook" | "rule" | "mode" | "user" | "no-ui";

/** How a hook run ended, as logged; `untrusted` means it was skipped because nobody reviewed it. */
export type LoggedHookStatus = "ok" | "blocked" | "error" | "timeout" | "untrusted";

/** The payload of an event; `type` selects the variant. */
export type WorkEventBody =
	| { type: "session.start"; reason: string }
	| { type: "user.message"; text: string }
	| {
			type: "tool.call";
			toolCallId: string;
			toolName: string;
			input: Record<string, unknown>;
			parentToolCallId?: string;
	  }
	| { type: "tool.result"; toolCallId: string; toolName: string; isError: boolean; preview: string }
	| {
			type: "policy.decision";
			toolCallId: string;
			toolName: string;
			outcome: "allow" | "deny";
			via: DecisionVia;
			stage: string;
			reason: string;
			mode: string;
			rule?: string;
	  }
	| {
			type: "hook.run";
			hookEvent: string;
			command: string;
			status: LoggedHookStatus;
			exitCode: number | null;
			durationMs: number;
	  }
	/** `before`/`after` are blob hashes; null means the file did not exist. */
	| { type: "file.change"; path: string; toolCallId: string; before: string | null; after: string | null }
	/** An action whose effects a rewind cannot undo, such as a shell command. */
	| { type: "irreversible"; toolCallId: string; kind: "command"; description: string }
	| { type: "checkpoint"; label: string; sessionEntryId: string | null }
	| { type: "rewind"; checkpoint: number; restored: string[]; deleted: string[]; conflicts: string[] };

/** An event as stored: the payload plus its position in the graph. */
export type WorkEvent = WorkEventBody & {
	/** Position in the log, starting at 0. */
	seq: number;
	/** The event this one follows; null for the first. A rewind points back at its checkpoint. */
	parent: number | null;
	time: string;
	agentId: string;
};

export type WorkEventType = WorkEvent["type"];

/** Narrow an event to one variant. */
export type WorkEventOf<T extends WorkEventType> = Extract<WorkEvent, { type: T }>;

type FieldKind = "string" | "string?" | "string|null" | "number" | "number|null" | "boolean" | "object" | "string[]";

const FIELDS: Record<WorkEventType, Record<string, FieldKind | readonly string[]>> = {
	"session.start": { reason: "string" },
	"user.message": { text: "string" },
	"tool.call": { toolCallId: "string", toolName: "string", input: "object", parentToolCallId: "string?" },
	"tool.result": { toolCallId: "string", toolName: "string", isError: "boolean", preview: "string" },
	"policy.decision": {
		toolCallId: "string",
		toolName: "string",
		outcome: ["allow", "deny"],
		via: ["hook", "rule", "mode", "user", "no-ui"],
		stage: "string",
		reason: "string",
		mode: "string",
		rule: "string?",
	},
	"hook.run": {
		hookEvent: "string",
		command: "string",
		status: ["ok", "blocked", "error", "timeout", "untrusted"],
		exitCode: "number|null",
		durationMs: "number",
	},
	"file.change": { path: "string", toolCallId: "string", before: "string|null", after: "string|null" },
	irreversible: { toolCallId: "string", kind: ["command"], description: "string" },
	checkpoint: { label: "string", sessionEntryId: "string|null" },
	rewind: { checkpoint: "number", restored: "string[]", deleted: "string[]", conflicts: "string[]" },
};

/** Validate one parsed log line as a header. Throws with the reason when it is not one. */
export function parseWorkLogHeader(value: unknown): WorkLogHeader {
	const record = asRecord(value, "header");
	if (record.type !== "workgraph") throw new Error('header: "type" must be "workgraph"');
	check(record, "version", "number", "header");
	check(record, "sessionId", "string", "header");
	check(record, "cwd", "string", "header");
	check(record, "createdAt", "string", "header");
	return record as unknown as WorkLogHeader; // every field was checked above
}

/** Validate one parsed log line as an event. Throws with the reason when it is not one. */
export function parseWorkEvent(value: unknown): WorkEvent {
	const record = asRecord(value, "event");
	const type = record.type;
	if (typeof type !== "string" || !Object.hasOwn(FIELDS, type)) {
		throw new Error(`event: unknown type ${JSON.stringify(type)}`);
	}
	check(record, "seq", "number", type);
	check(record, "parent", "number|null", type);
	check(record, "time", "string", type);
	check(record, "agentId", "string", type);
	for (const [field, kind] of Object.entries(FIELDS[type as WorkEventType])) {
		check(record, field, kind, type);
	}
	return record as unknown as WorkEvent; // every field of the variant was checked above
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`${what}: expected an object`);
	}
	return value as Record<string, unknown>;
}

function check(
	record: Record<string, unknown>,
	field: string,
	kind: FieldKind | readonly string[],
	what: string,
): void {
	const value = record[field];
	if (!matches(value, kind)) {
		const expected = typeof kind === "string" ? kind : kind.join(" | ");
		throw new Error(`${what}: "${field}" must be ${expected}, got ${JSON.stringify(value)}`);
	}
}

function matches(value: unknown, kind: FieldKind | readonly string[]): boolean {
	if (typeof kind !== "string") return typeof value === "string" && kind.includes(value);
	switch (kind) {
		case "string":
			return typeof value === "string";
		case "string?":
			return value === undefined || typeof value === "string";
		case "string|null":
			return value === null || typeof value === "string";
		case "number":
			return typeof value === "number" && Number.isFinite(value);
		case "number|null":
			return value === null || (typeof value === "number" && Number.isFinite(value));
		case "boolean":
			return typeof value === "boolean";
		case "object":
			return typeof value === "object" && value !== null && !Array.isArray(value);
		case "string[]":
			return Array.isArray(value) && value.every((item) => typeof item === "string");
	}
}
