// Remembers which project hooks the user has reviewed. A hook that changes is a new hook and needs review again.

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HookHandler } from "./config.ts";

interface TrustRecord {
	command: string;
	source: string;
	trustedAt: string;
}

/**
 * The reviewed-hooks file. Hooks from the user's own files and from managed policy run without
 * review; hooks that arrive with a project run only after `trust()`.
 */
export class HookTrustStore {
	private readonly path: string;
	private readonly records: Map<string, TrustRecord>;

	/** Opens the store at `path`. A missing or unreadable file means nothing has been reviewed yet. */
	constructor(path: string) {
		this.path = path;
		this.records = new Map(Object.entries(readRecords(path)));
	}

	/** Whether the handler may run. */
	isTrusted(handler: HookHandler): boolean {
		return handler.layer !== "project" || this.records.has(handler.id);
	}

	/** Mark a handler as reviewed and save. */
	trust(handler: HookHandler, now: Date = new Date()): void {
		this.records.set(handler.id, { command: handler.command, source: handler.source, trustedAt: now.toISOString() });
		this.save();
	}

	/** Forget a review. Returns false when the handler was not trusted. */
	revoke(handler: HookHandler): boolean {
		const removed = this.records.delete(handler.id);
		if (removed) this.save();
		return removed;
	}

	private save(): void {
		mkdirSync(dirname(this.path), { recursive: true });
		// Write-then-rename so a crash never leaves a half-written file that would drop every review.
		const temporary = `${this.path}.${process.pid}.tmp`;
		writeFileSync(
			temporary,
			`${JSON.stringify({ version: 1, trusted: Object.fromEntries(this.records) }, null, "\t")}\n`,
		);
		renameSync(temporary, this.path);
	}
}

function readRecords(path: string): Record<string, TrustRecord> {
	if (!existsSync(path)) return {};
	try {
		// The file is user-editable: anything that is not the expected shape counts as "nothing reviewed".
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null) return {};
		const trusted = (parsed as { trusted?: unknown }).trusted;
		if (typeof trusted !== "object" || trusted === null || Array.isArray(trusted)) return {};
		const records: Record<string, TrustRecord> = {};
		for (const [id, record] of Object.entries(trusted)) {
			if (typeof record !== "object" || record === null) continue;
			const { command, source, trustedAt } = record as Partial<TrustRecord>;
			if (typeof command === "string" && typeof source === "string" && typeof trustedAt === "string") {
				records[id] = { command, source, trustedAt };
			}
		}
		return records;
	} catch {
		return {};
	}
}
