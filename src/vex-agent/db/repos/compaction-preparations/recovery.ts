/**
 * Compaction-preparations — apply crash recovery.
 *
 * An `applying` row with a dead heartbeat is a cutover whose owner disappeared,
 * and the crash can have happened on EITHER side of Tx B's COMMIT. The two cases
 * are not cosmetically different: one means the session's history was already
 * archived, its summary already replaced and its generation already bumped; the
 * other means none of that happened. Guessing wrong either re-runs a cutover
 * that already committed, or discards one that did.
 *
 * THE ROW'S OWN STATUS IS THE PROOF, and it rules out the case this module was
 * originally written to detect.
 *
 * `casMarkApplied` flips `status` to `applied` in the SAME transaction as the
 * generation bump, the summary replacement and the archive. So if Tx B
 * committed, the row is `applied` and is not a candidate here at all. A row that
 * is STILL `applying` therefore PROVES Tx B did not commit — whatever the
 * generation says.
 *
 * That inverts the old discriminator. Finding
 * `sessions.checkpoint_generation == target_checkpoint_generation` on a
 * still-`applying` row does NOT mean "the cutover committed"; it means someone
 * ELSE took that generation — in practice the deterministic critical fallback,
 * which bumps `current + 1` and lands on the same number with a DIFFERENT
 * summary and a different archive. Marking the row `applied` there would claim
 * the prepared cutover happened when it did not, and would attribute the
 * fallback's history to the preparation's frozen corpus.
 *
 * So:
 *   generation == target  → CONFLICT. The target is spent. Terminal `failed` —
 *                           the request can never be satisfied at this
 *                           generation, and leaving it live would block every
 *                           future fork through the one-live-per-session index.
 *   anything else         → Tx B did not commit and the target is still free.
 *                           Restore `apply_requested` (never `summary_ready` —
 *                           the request is still outstanding) and release the
 *                           dead lease.
 *
 * Never infer from timestamps, heartbeat age, or the presence of an archive row.
 *
 * The conflict case is also now much rarer BY CONSTRUCTION: the critical ladder
 * defers while a preparation is `applying`, so the fallback cannot run against a
 * live cutover. This branch is the backstop for the crash window, not the
 * expected path.
 *
 * LOCK ORDER. Candidates are found in a read-only pass, then each is resolved in
 * its own transaction that takes `sessions FOR UPDATE` BEFORE touching the
 * preparation row — the same session-row-then-preparation-row order as the
 * capture and apply paths. Locking the preparation first would deadlock recovery
 * against a live cutover.
 */

import { executeWith, query, queryOneWith, withTransaction } from "../../client.js";
import { pruneCorpusIfFullyTerminal } from "./retention.js";

export interface StuckApplyingRecovery {
  /**
   * Rows whose frozen target generation was taken by another writer. Terminal
   * `failed` — see the module header for why this is never `applied`.
   */
  conflictedTerminal: number;
  /** Rows returned to `apply_requested` for another runner to consume. */
  restoredToRequested: number;
}

export async function recoverStuckApplying(
  staleThresholdMs: number,
): Promise<StuckApplyingRecovery> {
  const candidates = await query<{ id: number }>(
    `SELECT id FROM compaction_preparations
     WHERE status = 'applying'
       AND (apply_heartbeat_at IS NULL
            OR apply_heartbeat_at < NOW() - ($1::bigint || ' milliseconds')::interval)
     ORDER BY id ASC`,
    [staleThresholdMs],
  );

  const result: StuckApplyingRecovery = {
    conflictedTerminal: 0,
    restoredToRequested: 0,
  };
  for (const candidate of candidates) {
    const outcome = await resolveStuckApplying(candidate.id, staleThresholdMs);
    if (outcome === "failed") result.conflictedTerminal += 1;
    else if (outcome === "apply_requested") result.restoredToRequested += 1;
  }
  return result;
}

type StuckApplyingOutcome = "failed" | "apply_requested" | "no_longer_stuck";

async function resolveStuckApplying(
  id: number,
  staleThresholdMs: number,
): Promise<StuckApplyingOutcome> {
  return withTransaction(async (tx) => {
    // Session row first — see the lock-order note in the module header.
    const locked = await queryOneWith<{
      target_checkpoint_generation: number;
      checkpoint_generation: number;
    }>(
      tx,
      `SELECT p.target_checkpoint_generation,
              s.checkpoint_generation
       FROM compaction_preparations p
       JOIN sessions s ON s.id = p.session_id
       WHERE p.id = $1
       FOR UPDATE OF s`,
      [id],
    );
    if (!locked) return "no_longer_stuck";

    // The target generation is SPENT — by someone else, since a committed Tx B
    // would have left this row `applied` rather than `applying`.
    const targetTaken =
      locked.checkpoint_generation === locked.target_checkpoint_generation;

    if (targetTaken) {
      const rowCount = await executeWith(
        tx,
        `UPDATE compaction_preparations
         SET status             = 'failed',
             apply_locked_by    = NULL,
             apply_heartbeat_at = NULL,
             completed_at       = NOW(),
             last_error         = 'recovered_generation_conflict'
         WHERE id = $1
           AND status = 'applying'
           AND (apply_heartbeat_at IS NULL
                OR apply_heartbeat_at < NOW() - ($2::bigint || ' milliseconds')::interval)`,
        [id, staleThresholdMs],
      );
      if (rowCount !== 1) return "no_longer_stuck";
      await pruneCorpusIfFullyTerminal(tx, id);
      return "failed";
    }

    const rowCount = await executeWith(
      tx,
      `UPDATE compaction_preparations
       SET status             = 'apply_requested',
           apply_started_at   = NULL,
           apply_locked_by    = NULL,
           apply_heartbeat_at = NULL,
           last_error         = 'recovered_pre_commit'
       WHERE id = $1
         AND status = 'applying'
         AND (apply_heartbeat_at IS NULL
              OR apply_heartbeat_at < NOW() - ($2::bigint || ' milliseconds')::interval)`,
      [id, staleThresholdMs],
    );
    return rowCount === 1 ? "apply_requested" : "no_longer_stuck";
  });
}
