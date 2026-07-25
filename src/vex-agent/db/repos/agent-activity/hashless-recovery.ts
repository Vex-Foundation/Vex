/**
 * Stale hashless-intent recovery for `agent_activity` (design REVISION 1 R2,
 * R2c, migration 049; C7 — Batch 4 closure round 2: generalized off
 * Solana-only to EVERY chain family). Extracted from the sibling
 * `./swap-lifecycle.js` (which owns the in-execution CAS write protocol —
 * staged broadcast, confirm/fail, plan-abort) to keep that file under the
 * repo's 500-line cap: this is a genuinely separate concern — a periodic
 * WALL-CLOCK sweep that finalizes rows abandoned BEFORE staging ever
 * started, not a transition triggered by the venue handler's own execution.
 *
 * OWNER INSIGHT (C7): bridges enter/exit on ANY chain, so an EVM row left
 * `pending`+hashless by a hard process crash between intent creation and
 * broadcast deserves the SAME crash recovery a Solana row already had (K2's
 * `recoverStaleHashlessSolanaIntents`, C1's role-allowlist hardening). Before
 * this fix the `chain_family='solana'` predicate left every EVM hashless row
 * with no periodic owner — a crashed EVM allowance/swap/bridge-deposit leg
 * stayed pending forever, and the session-scoped bridge in-flight guard then
 * blocked that route for the rest of the session.
 *
 * RACE SAFETY ON EITHER FAMILY: the CAS predicate (`status='pending' AND
 * tx_hash IS NULL`) is the SAME one BOTH staging CASes require to succeed —
 * `markActivityBroadcast` (EVM) and `markActivitySolanaBroadcast` (Solana),
 * both in `./swap-lifecycle.js` — so the race resolves identically
 * regardless of family: if the signer wins first, this sweep simply finds
 * nothing to reap; if this sweep wins first, the signer's later CAS misses
 * and its own submit path is never reached (submission aborts before it can
 * broadcast).
 */

import { query } from "../../client.js";

import { sanitizeFailureReason } from "./validation.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent, AgentActivityEventRole } from "./types.js";

/**
 * W5 (design §2/R2/R2c; C7 — the lease now bounds EVERY chain family, not
 * just Solana): the generous lease (default 15 minutes) a row gets to reach
 * staging (a signed `tx_hash` persisted) before `recoverStaleHashlessIntents`
 * treats "never signed" as itself a definitive outcome. Long enough that a
 * running `closeAll` batch (design §5/R5 — N independent per-position rows
 * created up front, signed one at a time) never has a later item reaped
 * mid-flight. Renamed from `SOLANA_HASHLESS_INTENT_RECOVERY_LEASE_MS` (B2,
 * legacy cleanup): the Solana-only name was already stale after C7
 * generalized this recovery off Solana-only to every chain family.
 */
export const HASHLESS_INTENT_RECOVERY_LEASE_MS = 15 * 60 * 1000;

/**
 * Roles a Vex wallet locally signs+stages on ANY chain family through THIS
 * recovery sweep — the Solana lend/prediction roles (K1), `swap` and
 * `bridge_deposit` (both families), and the EVM-only allowance-plan roles
 * `allowance`/`allowance_reset` (C7 — generalizing the sweep off
 * Solana-only removes the reason those two were absent: a crashed EVM
 * approval tx is exactly as "definitely not attempted" as any other locally-
 * signed role here). This is a POSITIVE allowlist, not an incidental filter
 * (C1 fix — Codex-verified blocker): without it,
 * `recoverStaleHashlessIntents`'s bare `pending AND tx_hash IS NULL`
 * predicate also matches the logical `bridge_fill_expected` row
 * (`./bridge-intent.js`'s `createBridgeActivityIntent`), created `pending`
 * with `tx_hash` left NULL BY DESIGN — it is never signed locally; it is
 * filled by an external solver and later confirmed via
 * `confirmBridgeExpectedFill`. `bridge_fill_observed`/`bridge_refund` are
 * likewise externally-observed evidence rows, never locally signed. Absent
 * this allowlist, an old in-flight bridge would be falsely terminalized the
 * moment it outlived the lease, on EITHER chain family.
 *
 * `bridge_deposit` (the Vex-signed origin leg, also genuinely hashless until
 * signed) IS in the allowlist (Codex batch-4 turn-2 blocker 1, C1): it is
 * locally signed exactly like the roles above, and no bridge-side sweep owns
 * a hashless deposit row — without recovery here, a crash between intent
 * creation and staging would leave it pending forever, on either chain.
 */
const LOCALLY_SIGNABLE_ACTIVITY_ROLES: readonly AgentActivityEventRole[] = [
  "swap",
  "bridge_deposit",
  "allowance",
  "allowance_reset",
  "lend_deposit",
  "lend_withdraw",
  "lend_borrow_operate",
  "predict_buy",
  "predict_sell",
  "predict_claim",
  "predict_close",
];

/**
 * Stale hashless-intent recovery (design REVISION 1 R2, R2c; C7 —
 * generalized to EVERY chain family): a dedicated sweep CAS for `pending AND
 * tx_hash IS NULL` rows that have sat unsigned longer than `leaseMs` —
 * "definitely not attempted", the same category `abortPlannedEvents`
 * (`./swap-lifecycle.js`) finalizes for sibling legs, just on a wall-clock
 * trigger instead of an upstream-leg trigger.
 *
 * Scoped to `LOCALLY_SIGNABLE_ACTIVITY_ROLES` (see that constant's doc) so a
 * logical or externally-observed row (`bridge_fill_expected`/
 * `bridge_fill_observed`/`bridge_refund`) can never be mistaken for an
 * abandoned local signing attempt, on either chain.
 *
 * Bounded by `limit` (mirrors `listPendingOlderThan`'s FIX-SPINE C11
 * discipline) so a large backlog cannot starve other sync work in the same
 * periodic tick. Returns every row it finalized, mapped — never throws for
 * "nothing qualified".
 *
 * Formerly `recoverStaleHashlessSolanaIntents` (Solana-only, K2/C1) — the
 * sole caller (`sync/solana-activity-repair.ts`) is renamed in the SAME
 * change, so no deprecated alias is exported; a full-tree search before this
 * rename found no other caller of the old name.
 */
export async function recoverStaleHashlessIntents(
  leaseMs: number,
  limit: number,
): Promise<AgentActivityEvent[]> {
  const rows = await query<Record<string, unknown>>(
    `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = 'unknown',
            failure_reason = $1, updated_at = NOW()
      WHERE id IN (
        SELECT id FROM agent_activity
         WHERE status = 'pending' AND tx_hash IS NULL
           AND event_role = ANY($4::text[])
           AND created_at < NOW() - make_interval(secs => $2::float8)
         ORDER BY created_at ASC
         LIMIT $3
      )
      RETURNING *`,
    [
      sanitizeFailureReason("not attempted: stale hashless intent — never signed within the recovery lease"),
      leaseMs / 1000,
      limit,
      LOCALLY_SIGNABLE_ACTIVITY_ROLES,
    ],
  );
  return rows.map(mapRow);
}
