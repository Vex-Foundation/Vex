/**
 * Agent Scan activity repo — VERIFICATION BOOKKEEPING on a not-yet-terminal row.
 *
 * A different reason to change from the CAS state transitions in the parent
 * `../swap-lifecycle.js`: those move `status` and are once-only; these record
 * what we currently KNOW about a row that is still `pending`, and are written
 * repeatedly by the repair sweeps. The parent file already drew this line in
 * prose ("Repair-sweep bookkeeping") — this module makes it structural, exactly
 * as the fast-lane signalling and the read queries were split out before it.
 *
 * MOVE-ONLY at creation: `touchLastChecked` and `clearVerificationStall` came
 * across verbatim and are re-exported from `../swap-lifecycle.js`, so no caller's
 * import changed. Their signatures and behaviour are CONTRACTS OWNED BY THE
 * PENDING-FALLBACK WORKSTREAM (R2) — this module owns the file, not those two
 * functions' shape.
 */

import { execute, queryOne } from "../../../client.js";
import logger from "@utils/logger.js";
import type { PendingReason } from "../provenance-vocabulary.js";
import { STALL_INCREMENT_MIN_INTERVAL_MS, type VerificationReason } from "../types.js";

/**
 * Repair-sweep bookkeeping — a lookup found nothing new to report yet.
 *
 * Two jobs in one statement (migration 065):
 *
 * 1. FAIRNESS. `last_checked_at` moves, so the candidate queries — which order
 *    by it under a LIMIT — rotate this row to the back and stop it pinning the
 *    window against newer pending rows.
 * 2. STALL VISIBILITY. `verification_attempts` increments and
 *    `last_verification_reason` records WHY this attempt could not conclude, so
 *    a row that has been unverifiable for forty minutes can say so to the user
 *    and to the agent instead of dying in a debug log.
 *
 * `reason` is a MEMBER OF THE CLOSED 065 VOCABULARY (`VerificationReason`), not
 * a free string. The type is the enforcement: this column is rendered verbatim
 * to the user and to the agent, and three sweeps used to write seven codes the
 * "closed" set had never heard of. It stays optional for callers that genuinely
 * have nothing to name, though "pending" with no reason is exactly the
 * uninformative state migration 065 exists to end.
 *
 * ── THE COUNTER IS THROTTLED, AND `last_checked_at` IS NOT (migration 068) ──
 *
 * `verification_attempts` reaches its stall threshold in 20 increments, and that
 * threshold's documented meaning is ~10-20 MINUTES. At the pending lane's 5 s
 * cadence an unthrottled counter reaches it in 100 seconds, so a healthy
 * transaction that merely is not known to the node we asked would render as
 * "verification stalled" — a lie about what the system knows.
 *
 * So the two facts are separated: `last_checked_at` moves on EVERY check (the
 * fairness rotation and the UI's "last checked" line both need that), while the
 * counter increments at most once per `STALL_INCREMENT_MIN_INTERVAL_MS`,
 * recorded in its own column. Throttling on `last_checked_at` itself cannot
 * work — every check refreshes it, so it would never be 30 s old and the counter
 * would increment once and then never again.
 *
 * `claimToken`, when given, is the pending lane's fence: this is a POST-RPC
 * write, and a worker whose lease expired mid-observation must not stamp a stale
 * reason over a fresher one. It writes zero rows instead.
 *
 * THIS NEVER TERMINALIZES ANYTHING. The counter feeds a DERIVED read-side flag;
 * no threshold on it may ever write `status`.
 */
export async function touchLastChecked(
  id: number,
  reason?: VerificationReason,
  claimToken?: string,
): Promise<void> {
  const fence = claimToken === undefined ? "" : " AND evm_claim_token = $4::uuid";
  const params: unknown[] = [id, reason ?? null, STALL_INCREMENT_MIN_INTERVAL_MS / 1000];
  if (claimToken !== undefined) params.push(claimToken);
  await execute(
    `UPDATE agent_activity
        SET last_checked_at = NOW(), updated_at = NOW(),
            verification_attempts = verification_attempts
              + CASE WHEN ${INCREMENT_DUE_SQL} THEN 1 ELSE 0 END,
            last_verification_increment_at = CASE
              WHEN ${INCREMENT_DUE_SQL} THEN NOW()
              ELSE last_verification_increment_at END,
            last_verification_reason = COALESCE($2, last_verification_reason)
      WHERE id = $1 AND status = 'pending'${fence}`,
    params,
  );
}

/**
 * Is the counter allowed to increment on this check?
 *
 * `<=`, not `<`: a check at exactly the interval boundary must increment, or the
 * test written against "a check after 30 s produces the next increment" fails on
 * an off-by-one that nobody would find later.
 */
const INCREMENT_DUE_SQL = `(
  last_verification_increment_at IS NULL
  OR last_verification_increment_at <= NOW() - make_interval(secs => $3::float8)
)`;

/**
 * A verification attempt CONCLUDED — clear the stall counter.
 *
 * Called when an observation genuinely answered the question but the row is
 * legitimately still in flight (e.g. a Solana signature seen at `processed`
 * commitment). The counter must measure a STALL, not age: without this reset an
 * ordinary slow-but-healthy transaction would eventually render as
 * "verification stalled", which is a lie about the system's own knowledge.
 *
 * IT ALSO NULLS THE THROTTLE CLOCK (migration 068). Without that, a fresh run of
 * inconclusive checks inherits the PREVIOUS run's throttle boundary and its
 * first increment is mistimed — the counter would be reset while its clock was
 * not, which is two halves of one fact disagreeing.
 *
 * `claimToken` fences it exactly as `touchLastChecked` is fenced: this is a
 * post-RPC write.
 */
export async function clearVerificationStall(id: number, claimToken?: string): Promise<void> {
  const fence = claimToken === undefined ? "" : " AND evm_claim_token = $2::uuid";
  const params: unknown[] = [id];
  if (claimToken !== undefined) params.push(claimToken);
  await execute(
    `UPDATE agent_activity
        SET last_checked_at = NOW(), updated_at = NOW(),
            verification_attempts = 0, last_verification_reason = NULL,
            last_verification_increment_at = NULL
      WHERE id = $1 AND status = 'pending'${fence}`,
    params,
  );
}

// ── Why a row is STILL PENDING (migration 067, `pending_reason`) ──────

/**
 * WHERE the caller is writing from, and therefore which extra CAS clause guards
 * the write. A DISCRIMINATED UNION, not an optional token, so a claim-window
 * caller cannot forget the fence and a handler caller is not asked for a token
 * it cannot have.
 */
export type PendingReasonContext =
  | { readonly kind: "handler_return" }
  | { readonly kind: "claim"; readonly claimToken: string };

/** Why `notePendingReason` wrote nothing. Never a bare `false`. */
export type NotePendingReasonMiss = "not_pending" | "claim_lost" | "already_reasoned";

/**
 * Record WHY this row is still pending (migration 067's `pending_reason`).
 *
 * Does NOT touch the stall counter: `touchLastChecked` counts consecutive
 * INCONCLUSIVE CHECKS (migration 065), and a handler that never looked has made
 * no check. Two different facts, two columns, two writers.
 *
 * Both contexts keep `WHERE id = $1 AND status = 'pending'` and add ONE clause:
 *
 * - `claim` → `AND evm_claim_token = $token`, the pending-fallback lane's own
 *   fence, verbatim. This is the one post-RPC write that would otherwise sit
 *   outside it, and a stale worker must not stamp a superseded reason over a
 *   fresher one. Zero rows while the row is still pending ⇒ `claim_lost`.
 * - `handler_return` → `AND pending_reason IS NULL`, write-once by the handler.
 *   The handler's reason is the INITIAL statement of why a row is pending; every
 *   later reason comes from a chain observation and is strictly fresher, so a
 *   late handler write must never clobber one. Zero rows ⇒ `already_reasoned`.
 *
 * NAMED TRADEOFF: in the rare interleaving where the lane observes before a slow
 * handler returns, the handler's more specific `settlement_undecodable` is
 * refused and the row keeps the lane's reason. The row still carries a TRUE
 * reason, and the amount gap is recorded separately at confirm time through
 * `settlement_source`. Letting the handler overwrite would reintroduce exactly
 * the stale-over-fresh write the fence exists to stop.
 *
 * `evm_claim_token` is the pending-fallback workstream's column (its migration
 * `068`) and is referenced ONLY in the `claim` branch.
 */
export async function notePendingReason(
  id: number,
  reason: PendingReason,
  context: PendingReasonContext,
): Promise<{ applied: boolean; reason?: NotePendingReasonMiss }> {
  const row = context.kind === "claim"
    ? await queryOne<{ id: number }>(
      `UPDATE agent_activity
          SET pending_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND evm_claim_token = $3::uuid
        RETURNING id`,
      [id, reason, context.claimToken],
    )
    : await queryOne<{ id: number }>(
      `UPDATE agent_activity
          SET pending_reason = $2, updated_at = NOW()
        WHERE id = $1 AND status = 'pending' AND pending_reason IS NULL
        RETURNING id`,
      [id, reason],
    );
  if (row) return { applied: true };

  const current = await queryOne<{ status: string }>(
    `SELECT status FROM agent_activity WHERE id = $1`,
    [id],
  );
  if (!current || current.status !== "pending") return { applied: false, reason: "not_pending" };
  if (context.kind === "claim") {
    // The lane's own event name, emitted here because this is the write site
    // that observes the zero-row result. One event name, whoever writes.
    logger.debug("sync.evm_claim.lost", { id, caller: "notePendingReason" });
    return { applied: false, reason: "claim_lost" };
  }
  return { applied: false, reason: "already_reasoned" };
}
