/**
 * Post-commit signalling for the apply surface.
 *
 * The bus contract (`engine/runtime/compaction-bus.ts`) is binding on every
 * producer: emit ONLY AFTER the transaction that made the row fetchable has
 * COMMITTED. The renderer treats the event purely as an invalidation signal and
 * immediately re-reads the preparation — an emit issued inside the transaction
 * would make that refetch observe the OLD state and then not refetch again
 * until the 60 s fallback poll, leaving a stale button for a minute.
 *
 * Two rules follow, and both are enforced at the call sites rather than here:
 *
 *   1. never call this from inside a transaction, and never from a path that
 *      rolled back — a rolled-back transition did not happen;
 *   2. never call this on a LOST CAS. Every apply edge is compare-and-set, and
 *      a `false` return means another writer owns the row. Emitting then would
 *      announce a transition this process did not perform.
 *
 * `summaryReady` is `true` for every transition on this surface, and that is an
 * FSM fact rather than an assumption: the only way into `apply_requested` is
 * from `summary_ready`, and the schema's `cprep_ready_requires_summary` CHECK
 * makes the alternative unrepresentable. Everything here is downstream of that
 * edge.
 *
 * The payload stays metadata-only — no summary, no corpus, no error prose.
 */

import {
  COMPACTION_PREPARATION_EVENT_TYPE,
  compactionPreparationBus,
} from "@vex-agent/engine/runtime/compaction-bus.js";
import type { PreparationStatus } from "@vex-agent/db/repos/compaction-preparations/index.js";

/**
 * Announce a COMMITTED apply-surface transition. Call only after the commit,
 * and only when this process's CAS actually won.
 */
export function emitApplyTransition(
  sessionId: string,
  status: PreparationStatus,
): void {
  compactionPreparationBus.emit({
    type: COMPACTION_PREPARATION_EVENT_TYPE,
    sessionId,
    status,
    summaryReady: true,
    correlationId: null,
  });
}
