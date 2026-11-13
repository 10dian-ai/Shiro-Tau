// Projections: views folded out of work log events. Panels, audits and summaries are all projections.

import type { WorkEvent, WorkEventOf } from "./events.ts";

/** A view built by folding events in order. `apply` returns the next state. */
export interface Projection<S> {
	initial(): S;
	apply(state: S, event: WorkEvent): S;
}

/** Fold `events` through `projection`. Pass `log.branch()` for the active branch only. */
export function project<S>(events: readonly WorkEvent[], projection: Projection<S>): S {
	let state = projection.initial();
	for (const event of events) state = projection.apply(state, event);
	return state;
}

/** Net change to one file across the folded events. */
export interface FileChangeSummary {
	path: string;
	/** Blob the file held before the first change; null if it did not exist. */
	before: string | null;
	/** Blob the file holds after the last change; null if it was deleted. */
	after: string | null;
	/** How many tool calls changed it. */
	edits: number;
}

/** Files changed, keyed by path, with files that ended up unchanged left out. */
export const changedFiles: Projection<Map<string, FileChangeSummary>> = {
	initial: () => new Map(),
	apply(state, event) {
		if (event.type !== "file.change") return state;
		const summary = state.get(event.path);
		if (!summary) {
			state.set(event.path, { path: event.path, before: event.before, after: event.after, edits: 1 });
		} else if (event.after === summary.before) {
			state.delete(event.path);
		} else {
			summary.after = event.after;
			summary.edits += 1;
		}
		return state;
	},
};

/** Every permission decision, oldest first: the audit trail. */
export const auditTrail: Projection<WorkEventOf<"policy.decision">[]> = {
	initial: () => [],
	apply(state, event) {
		if (event.type === "policy.decision") state.push(event);
		return state;
	},
};
