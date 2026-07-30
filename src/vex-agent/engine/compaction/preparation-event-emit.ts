/**
 * Post-commit bus emit for the branch workers.
 *
 * THE CONTRACT (binding, stated in `runtime/compaction-bus.ts`): emit only
 * AFTER the transaction that made the new state fetchable has COMMITTED. The
 * renderer treats the event purely as an invalidation signal and immediately
 * re-reads the preparation; an emit issued any earlier makes that refetch
 * observe the OLD row and then not refetch again until the 60s fallback poll.
 *
 * WHY THE STATUS IS RE-READ RATHER THAN PASSED IN. The event carries "the
 * status the row carries AFTER the committed transition", and a worker's local
 * copy is the status it saw when it CLAIMED — which for branch B is routinely
 * stale by the time it commits, because the row can be superseded or applied
 * while the branch is working. Branch B's own transitions do not even change
 * the row status, only the `chunks_*` columns, so there is nothing to pass. One
 * indexed read on a rare path buys an event that is true.
 *
 * FAIL-SOFT. A signal-layer failure must never fail work that is already
 * durable: the DB is the source of truth and the renderer's fallback poll still
 * converges. Every failure here is logged and swallowed.
 */

import { getPreparationById } from "../../db/repos/compaction-preparations/index.js";
import {
  COMPACTION_PREPARATION_EVENT_TYPE,
  compactionPreparationBus,
} from "../runtime/compaction-bus.js";
import logger from "@utils/logger.js";

/**
 * Announce a COMMITTED preparation transition. Call sites must already have a
 * `true`/`ok` result from the CAS that wrote it — never on a lost lease or a
 * refused CAS, where nothing was written and there is nothing to announce.
 */
export async function emitPreparationCommitted(
  preparationId: number,
): Promise<void> {
  try {
    const row = await getPreparationById(preparationId);
    if (!row) return;
    compactionPreparationBus.emit({
      type: COMPACTION_PREPARATION_EVENT_TYPE,
      sessionId: row.sessionId,
      status: row.status,
      // Metadata only: whether a summary exists, never the summary.
      summaryReady: row.summaryOutput !== null,
      correlationId: null,
    });
  } catch (err) {
    logger.warn("compaction-prep.event_emit_failed", {
      preparationId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
