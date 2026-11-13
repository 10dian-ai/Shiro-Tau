// Public surface of the work graph.

export { BlobStore, hashContent } from "./blob-store.ts";
export {
	type DecisionVia,
	type LoggedHookStatus,
	parseWorkEvent,
	parseWorkLogHeader,
	WORKGRAPH_FORMAT_VERSION,
	type WorkEvent,
	type WorkEventBody,
	type WorkEventOf,
	type WorkEventType,
	type WorkLogHeader,
} from "./events.ts";
export {
	FileHistory,
	type RewindOptions,
	type RewindPlan,
	type RewindResult,
	type RewindStep,
} from "./file-history.ts";
export {
	type AppendOptions,
	WorkLog,
	WorkLogError,
	type WorkLogErrorCode,
	type WorkLogInit,
	type WorkLogOptions,
} from "./log.ts";
export { auditTrail, changedFiles, type FileChangeSummary, type Projection, project } from "./projections.ts";
