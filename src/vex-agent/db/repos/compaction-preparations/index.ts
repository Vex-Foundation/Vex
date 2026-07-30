/**
 * Compaction-preparations repo — public gate.
 *
 * Explicit named exports only. Everything not listed here is an implementation
 * detail of the state machine; `transaction-scope.ts` in particular is private
 * on purpose, so no caller can open its own scope around a terminal transition
 * and separate it from the corpus prune.
 */

export type {
  ApplySource,
  Branch,
  BranchStatus,
  ChunksBranchStatus,
  CompactionPreparation,
  CompactionPreparationRow,
  NewCompactionPreparation,
  PreparationStatus,
  SummaryBranchStatus,
} from "./types.js";

export {
  APPLY_SOURCES,
  CHUNKS_BRANCH_STATUSES,
  LIVE_PREPARATION_STATUSES,
  PREPARATION_COLUMNS,
  PREPARATION_STATUSES,
  SUMMARY_BRANCH_STATUSES,
  mapRow,
} from "./types.js";

export {
  FROZEN_CHUNKS_SNAPSHOT_VERSION,
  FrozenChunksOutputSchema,
  type FrozenChunk,
  type FrozenChunksOutput,
  type FrozenThemeSource,
} from "./frozen-output-schema.js";

export {
  APPLY_STALE_THRESHOLD_MS,
  BRANCH_HEARTBEAT_INTERVAL_MS,
  BRANCH_RETRY_BACKOFF_BASE_MS,
  BRANCH_STALE_THRESHOLD_MS,
  CHUNKS_MAX_ATTEMPTS,
  MAX_SUMMARY_CHARS,
  SUMMARY_MAX_ATTEMPTS,
} from "./policy.js";

export { assertCorpusFingerprint } from "./corpus-fingerprint.js";

export {
  createPreparation,
  supersedeAndReplace,
  type CreatePreparationResult,
  type SupersedeAndReplaceResult,
} from "./create.js";

export {
  branchHeartbeat,
  casBranchFailed,
  casFrozenTailFailed,
  claimBranch,
  claimFrozenChunksTail,
  recoverStaleBranch,
  type BranchFailureResult,
} from "./branch-leases.js";

export {
  casChunksApplied,
  casFreezeChunksOutput,
  casMarkFailed,
  casSummaryReady,
  type ChunksLandedCounts,
  type FreezeChunksInput,
  type SummaryReadyInput,
  type SummaryReadyResult,
} from "./branch-transitions.js";

export {
  applyHeartbeat,
  casBeginApply,
  casDeferApply,
  casFailApply,
  casMarkApplied,
  casRequestApply,
  recordMoneyGateBypassReasons,
  type BeginApplyResult,
  type RequestApplyResult,
} from "./apply-transitions.js";

export {
  recoverStuckApplying,
  type StuckApplyingRecovery,
} from "./recovery.js";

export { getLivePreparationPressureState } from "./pressure-state.js";

export {
  getFrozenChunksOutput,
  getLivePreparationForSession,
  getPreparationById,
  listPreparationsForSession,
} from "./read.js";
