// The work log: one append-only JSONL file per session that every part of Shiro writes its events to.

import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
	parseWorkEvent,
	parseWorkLogHeader,
	WORKGRAPH_FORMAT_VERSION,
	type WorkEvent,
	type WorkEventBody,
	type WorkLogHeader,
} from "./events.ts";

export type WorkLogErrorCode = "exists" | "missing" | "corrupt" | "unsupported-version";

/** A work log could not be created or read. `code` says why. */
export class WorkLogError extends Error {
	readonly code: WorkLogErrorCode;

	constructor(code: WorkLogErrorCode, message: string) {
		super(message);
		this.name = "WorkLogError";
		this.code = code;
	}
}

export interface WorkLogInit {
	sessionId: string;
	cwd: string;
}

export interface WorkLogOptions {
	/** Clock for event timestamps. Tests pass a fixed one. */
	now?: () => Date;
}

export interface AppendOptions {
	/** Defaults to "main", the session's primary agent. */
	agentId?: string;
	/** Defaults to the last event. A rewind passes its checkpoint to start a new branch. */
	parent?: number | null;
}

/**
 * An open work log. Events are kept in memory and every append is written to disk before it returns,
 * so a crash loses at most the event being written.
 */
export class WorkLog {
	readonly path: string;
	readonly header: WorkLogHeader;
	private readonly entries: WorkEvent[];
	private readonly now: () => Date;

	private constructor(path: string, header: WorkLogHeader, entries: WorkEvent[], now: () => Date) {
		this.path = path;
		this.header = header;
		this.entries = entries;
		this.now = now;
	}

	/** Create a new log file. Fails when the file already exists. */
	static create(path: string, init: WorkLogInit, options: WorkLogOptions = {}): WorkLog {
		if (existsSync(path)) throw new WorkLogError("exists", `Work log already exists: ${path}`);
		const now = options.now ?? (() => new Date());
		const header: WorkLogHeader = {
			type: "workgraph",
			version: WORKGRAPH_FORMAT_VERSION,
			sessionId: init.sessionId,
			cwd: init.cwd,
			createdAt: now().toISOString(),
		};
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, `${JSON.stringify(header)}\n`, { flag: "wx" });
		return new WorkLog(path, header, [], now);
	}

	/**
	 * Open an existing log. A partial last line (a crash mid-append) is cut off; any other damage
	 * fails with code "corrupt" naming the line.
	 */
	static open(path: string, options: WorkLogOptions = {}): WorkLog {
		if (!existsSync(path)) throw new WorkLogError("missing", `Work log not found: ${path}`);
		const text = readFileSync(path, "utf8");
		const lastNewline = text.lastIndexOf("\n");
		if (lastNewline === -1) throw new WorkLogError("corrupt", `${path}: the header line is incomplete`);
		if (lastNewline !== text.length - 1) truncateSync(path, Buffer.byteLength(text.slice(0, lastNewline + 1)));

		const lines = text.slice(0, lastNewline).split("\n");
		const header = readLine(path, lines, 0, parseWorkLogHeader);
		if (header.version !== WORKGRAPH_FORMAT_VERSION) {
			throw new WorkLogError(
				"unsupported-version",
				`${path}: format version ${header.version} is not supported (this build reads version ${WORKGRAPH_FORMAT_VERSION})`,
			);
		}
		const entries: WorkEvent[] = [];
		for (let index = 1; index < lines.length; index++) {
			const event = readLine(path, lines, index, parseWorkEvent);
			if (event.seq !== entries.length) {
				throw new WorkLogError("corrupt", `${path}:${index + 1}: expected seq ${entries.length}, got ${event.seq}`);
			}
			entries.push(event);
		}
		return new WorkLog(path, header, entries, options.now ?? (() => new Date()));
	}

	/** Open the log at `path`, creating it when it does not exist yet. */
	static openOrCreate(path: string, init: WorkLogInit, options: WorkLogOptions = {}): WorkLog {
		return existsSync(path) ? WorkLog.open(path, options) : WorkLog.create(path, init, options);
	}

	/** All events in the order they were written, including abandoned branches. */
	get events(): readonly WorkEvent[] {
		return this.entries;
	}

	/** The event at `seq`, if there is one. */
	get(seq: number): WorkEvent | undefined {
		return this.entries[seq];
	}

	/** Write one event and return it as stored. */
	append(body: WorkEventBody, options: AppendOptions = {}): WorkEvent {
		const seq = this.entries.length;
		const parent = options.parent === undefined ? (seq === 0 ? null : seq - 1) : options.parent;
		const event: WorkEvent = {
			...body,
			seq,
			parent,
			time: this.now().toISOString(),
			agentId: options.agentId ?? "main",
		};
		appendFileSync(this.path, `${JSON.stringify(event)}\n`);
		this.entries.push(event);
		return event;
	}

	/**
	 * The active branch: the events from the first one to the last one written, following `parent`
	 * links. Events that a rewind left behind are not on it.
	 */
	branch(): WorkEvent[] {
		const branch: WorkEvent[] = [];
		let seq: number | null = this.entries.length - 1;
		while (seq !== null && seq >= 0) {
			const event: WorkEvent = this.entries[seq];
			branch.push(event);
			seq = event.parent;
		}
		return branch.reverse();
	}
}

function readLine<T>(path: string, lines: string[], index: number, parse: (value: unknown) => T): T {
	try {
		return parse(JSON.parse(lines[index]));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new WorkLogError("corrupt", `${path}:${index + 1}: ${reason}`);
	}
}
