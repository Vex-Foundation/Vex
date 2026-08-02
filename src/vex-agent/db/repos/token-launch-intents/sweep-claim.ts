/**
 * The identity sweep's CANDIDATE CLAIM — a different reason to change from both
 * `./reads.js` (pure, pool-level reads) and `./writers.js` (session-scoped CAS
 * state transitions): this file owns FAIRNESS, and it is neither a pure read
 * nor a state transition.
 *
 * ── The starvation this replaces ───────────────────────────────────────────
 *
 * The previous candidate query was `ORDER BY created_at ASC LIMIT 25` over a
 * set the sweep may leave UNCHANGED. Ambiguity is the sweep's most common
 * answer — not yet mined, transient RPC failure, unreadable receipt — and an
 * ambiguous row keeps its `created_at` and its `broadcast_pending` status. So
 * 25 permanently-ambiguous launches pin the window shut and row 26 is NEVER
 * looked at, however long it waits. The bug is silent: the sweep reports
 * `checked: 25` every tick and looks healthy.
 *
 * ── The rotation ───────────────────────────────────────────────────────────
 *
 * Serving a row STAMPS `last_checked_at`, and the ordering is
 * `COALESCE(last_checked_at, created_at) ASC` — least-recently-inspected first,
 * so every inspection moves that row to the back of the queue and the window
 * advances on every tick regardless of the answer. This is the repo's
 * established scheduling shape, not a new invention: `agent_activity` has used
 * `last_checked_at` with exactly this `COALESCE(...) ASC, id ASC` ordering since
 * migration 044, and the bridge sweep's `COALESCE(last_attempted_at,
 * created_at) ASC` is the same idea (`bridge-activity-repair-fairness.ts`).
 *
 * SELECT and stamp are ONE statement, so a crash between them is
 * unrepresentable, and `FOR UPDATE SKIP LOCKED` means two concurrent sweeps
 * take DISJOINT batches instead of both chasing the same rows.
 *
 * Pool-level, deliberately, and UNSCOPED by session — this is a global
 * crash-recovery sweep whose candidates span arbitrary sessions. It grants no
 * cross-session authority: the stamp is scheduling bookkeeping and touches no
 * money, status, hash or identity column, and every WRITE the sweep then
 * performs still goes through the session-scoped CAS writers using the session
 * id carried on the row it just claimed.
 */

import { query } from "../../client.js";
import { mapRow, SELECT_COLUMNS, type TokenLaunchIntent } from "./types.js";

/**
 * Claim up to `limit` broadcast-but-unresolved launches, least-recently-checked
 * first, stamping each one's `last_checked_at` in the same statement.
 *
 * `tx_hash IS NOT NULL` mirrors what the DB CHECK already guarantees for this
 * status, so a row with nothing to look up can never enter the batch.
 */
export async function claimBroadcastPendingForSweep(limit: number): Promise<TokenLaunchIntent[]> {
  const rows = await query<Record<string, unknown>>(
    `WITH candidates AS (
       SELECT intent_id AS candidate_intent_id
         FROM token_launch_intents
        WHERE status = 'broadcast_pending' AND tx_hash IS NOT NULL
        ORDER BY COALESCE(last_checked_at, created_at) ASC, intent_id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
     )
     UPDATE token_launch_intents t
        SET last_checked_at = NOW()
       FROM candidates c
      WHERE t.intent_id = c.candidate_intent_id
      RETURNING ${SELECT_COLUMNS}`,
    [limit],
  );
  return rows.map(mapRow);
}
