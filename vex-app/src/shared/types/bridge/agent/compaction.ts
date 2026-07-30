import type { Result } from "../../../ipc/result.js";
import type {
  CompactionApplyRequestInput,
  CompactionApplyRequestResult,
  CompactionPreparationInput,
  CompactionPreparationResult,
} from "../../../schemas/compaction-preparation.js";
import type {
  CompactionHistoryInput,
  CompactionHistoryResult,
  CompactionRetryInput,
  CompactionRetryResult,
  CompactionStatusInput,
  CompactionStatusResult,
} from "../../../schemas/compaction.js";

/**
 * Compaction status + history (read) + retry (the one mutation).
 *  - `getStatus` (7-1): latest job + active count for the runtime-bar chip;
 *    `null` for a missing/deleted/out-of-scope session.
 *  - `listHistory` (7-2a): the session's compaction-generation timeline for
 *    the memory panel; `null` for a missing/foreign session.
 *  - `retry` (8-5): re-enqueue a permanently-failed generation for another
 *    attempt. The renderer never controls the executor's scheduling.
 *
 * Compaction v2 (the `compaction_preparations` track):
 *  - `getPreparation`: bounded progress projection of the session's most
 *    recent preparation; `null` when there is none or the session is
 *    missing/foreign. Never carries the corpus, the summary or error prose.
 *  - `requestApply`: exactly ONE compare-and-swap
 *    `summary_ready → apply_requested`. It never performs the cutover — the
 *    runner consumes the standing request at its next iteration boundary.
 */
export interface CompactionBridge {
  readonly getStatus: (
    input: CompactionStatusInput,
  ) => Promise<Result<CompactionStatusResult>>;
  readonly listHistory: (
    input: CompactionHistoryInput,
  ) => Promise<Result<CompactionHistoryResult>>;
  readonly retry: (
    input: CompactionRetryInput,
  ) => Promise<Result<CompactionRetryResult>>;
  readonly getPreparation: (
    input: CompactionPreparationInput,
  ) => Promise<Result<CompactionPreparationResult>>;
  readonly requestApply: (
    input: CompactionApplyRequestInput,
  ) => Promise<Result<CompactionApplyRequestResult>>;
}
