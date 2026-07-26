/**
 * memory_jobs repo — public re-exports (controlled surface).
 */

export type {
  MemoryJob,
  MemoryJobRow,
  MemoryJobKind,
  MemoryJobStatus,
  JobProgress,
} from "./types.js";

export { JOB_COLUMNS, mapRow } from "./types.js";

// FIX2-SPINE C19 (Codex final-review finding 4): `enqueueReconcileJob` /
// `resetReconcileJob` are removed here — see crud.ts's file header.
export {
  enqueueConsolidateJob,
  claimNextDueJob,
  heartbeat,
  markCompleted,
  markFailed,
  recoverStaleRunning,
  bumpJobInference,
  getJobProgress,
  getJobById,
  listJobsByStatus,
} from "./crud.js";
