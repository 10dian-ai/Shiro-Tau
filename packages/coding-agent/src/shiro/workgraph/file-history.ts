// File history: records what each tool call changed on disk, takes checkpoints, and rewinds files to one.

import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { BlobStore } from "./blob-store.ts";
import { hashContent } from "./blob-store.ts";
import type { WorkEventOf } from "./events.ts";
import type { WorkLog } from "./log.ts";

/** One file a rewind would touch. */
export interface RewindStep {
	/** Path as written in the log: relative to the log's cwd when inside it. */
	path: string;
	absolutePath: string;
	/** Blob to restore, or null to delete the file. */
	to: string | null;
	/** What the file should hold now if only recorded tool calls touched it. */
	expectedCurrent: string | null;
}

/** What a rewind to a checkpoint would do, computed without touching the disk. */
export interface RewindPlan {
	checkpoint: number;
	steps: RewindStep[];
	/** Actions after the checkpoint that cannot be undone, oldest first. */
	irreversible: WorkEventOf<"irreversible">[];
}

export interface RewindOptions {
	/** Overwrite files that changed outside recorded tool calls instead of reporting a conflict. */
	force?: boolean;
}

export interface RewindResult {
	restored: string[];
	deleted: string[];
	/** Files left alone because their content is not what the log expects. */
	conflicts: string[];
	irreversible: WorkEventOf<"irreversible">[];
	event: WorkEventOf<"rewind">;
}

interface PendingCapture {
	absolutePath: string;
	before: string | null;
}

/** Tracks file changes for one work log. Create one per open session. */
export class FileHistory {
	private readonly log: WorkLog;
	private readonly blobs: BlobStore;
	private readonly pending = new Map<string, PendingCapture[]>();

	constructor(log: WorkLog, blobs: BlobStore) {
		this.log = log;
		this.blobs = blobs;
	}

	/** Remember a file's content before `toolCallId` changes it. Call this before the tool runs. */
	captureBefore(toolCallId: string, absolutePath: string): void {
		const captures = this.pending.get(toolCallId) ?? [];
		if (captures.some((capture) => capture.absolutePath === absolutePath)) return;
		captures.push({ absolutePath, before: this.snapshot(absolutePath) });
		this.pending.set(toolCallId, captures);
	}

	/**
	 * Compare the files captured for `toolCallId` with the disk and log a `file.change` for each
	 * that differs. Call this after the tool ran, whether it succeeded or not.
	 */
	recordAfter(toolCallId: string): WorkEventOf<"file.change">[] {
		const captures = this.pending.get(toolCallId) ?? [];
		this.pending.delete(toolCallId);
		const changes: WorkEventOf<"file.change">[] = [];
		for (const { absolutePath, before } of captures) {
			const after = this.snapshot(absolutePath);
			if (after === before) continue;
			const event = this.log.append({
				type: "file.change",
				path: this.toLogPath(absolutePath),
				toolCallId,
				before,
				after,
			});
			changes.push(event as WorkEventOf<"file.change">);
		}
		return changes;
	}

	/** Mark a point files can later be rewound to. `sessionEntryId` ties it to the conversation. */
	checkpoint(label: string, sessionEntryId: string | null): WorkEventOf<"checkpoint"> {
		return this.log.append({ type: "checkpoint", label, sessionEntryId }) as WorkEventOf<"checkpoint">;
	}

	/** Checkpoints on the active branch, oldest first. */
	checkpoints(): WorkEventOf<"checkpoint">[] {
		return this.log.branch().filter((event) => event.type === "checkpoint");
	}

	/** Work out what rewinding to the checkpoint at `checkpointSeq` would do. */
	planRewind(checkpointSeq: number): RewindPlan {
		const branch = this.log.branch();
		const index = branch.findIndex((event) => event.seq === checkpointSeq);
		if (index === -1 || branch[index].type !== "checkpoint") {
			throw new Error(`No checkpoint ${checkpointSeq} on the active branch`);
		}
		const steps = new Map<string, RewindStep>();
		const irreversible: WorkEventOf<"irreversible">[] = [];
		for (const event of branch.slice(index + 1)) {
			if (event.type === "irreversible") irreversible.push(event);
			if (event.type !== "file.change") continue;
			const step = steps.get(event.path);
			if (step) {
				step.expectedCurrent = event.after;
			} else {
				// The first change after the checkpoint holds the content the file had at the checkpoint.
				steps.set(event.path, {
					path: event.path,
					absolutePath: this.fromLogPath(event.path),
					to: event.before,
					expectedCurrent: event.after,
				});
			}
		}
		return { checkpoint: checkpointSeq, steps: [...steps.values()], irreversible };
	}

	/**
	 * Paths in `plan` whose content on disk is neither what the log expects nor already what the
	 * checkpoint had: something other than a recorded tool call changed them. `rewind` leaves these
	 * alone unless forced, so callers ask the user about them first.
	 */
	findConflicts(plan: RewindPlan): string[] {
		return plan.steps.filter((step) => this.isConflict(step)).map((step) => step.path);
	}

	/**
	 * Put files back as they were at the checkpoint and start a new branch from it. A file whose
	 * content is not what the log expects was changed by something else; it is reported as a
	 * conflict and left alone unless `force` is set.
	 */
	rewind(checkpointSeq: number, options: RewindOptions = {}): RewindResult {
		const plan = this.planRewind(checkpointSeq);
		const restored: string[] = [];
		const deleted: string[] = [];
		const conflicts: string[] = [];
		for (const step of plan.steps) {
			if (this.currentHash(step.absolutePath) === step.to) continue;
			if (!options.force && this.isConflict(step)) {
				conflicts.push(step.path);
				continue;
			}
			if (step.to === null) {
				rmSync(step.absolutePath, { force: true });
				deleted.push(step.path);
			} else {
				mkdirSync(dirname(step.absolutePath), { recursive: true });
				writeFileSync(step.absolutePath, this.blobs.get(step.to));
				restored.push(step.path);
			}
		}
		this.pending.clear();
		const event = this.log.append(
			{ type: "rewind", checkpoint: checkpointSeq, restored, deleted, conflicts },
			{ parent: checkpointSeq },
		) as WorkEventOf<"rewind">;
		return { restored, deleted, conflicts, irreversible: plan.irreversible, event };
	}

	/** Store the file's content and return its hash; null when there is no regular file there. */
	private snapshot(absolutePath: string): string | null {
		const data = readRegularFile(absolutePath);
		return data === null ? null : this.blobs.put(data);
	}

	private isConflict(step: RewindStep): boolean {
		const current = this.currentHash(step.absolutePath);
		return current !== step.to && current !== step.expectedCurrent;
	}

	private currentHash(absolutePath: string): string | null {
		const data = readRegularFile(absolutePath);
		return data === null ? null : hashContent(data);
	}

	private toLogPath(absolutePath: string): string {
		const fromCwd = relative(this.log.header.cwd, absolutePath);
		const inside = fromCwd !== "" && !fromCwd.startsWith("..") && !isAbsolute(fromCwd);
		return inside ? fromCwd.split(sep).join("/") : absolutePath;
	}

	private fromLogPath(path: string): string {
		return isAbsolute(path) ? path : resolve(this.log.header.cwd, path);
	}
}

function readRegularFile(absolutePath: string): Buffer | null {
	if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) return null;
	return readFileSync(absolutePath);
}
