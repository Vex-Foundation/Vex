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
 *
 * SESSION AND LINKED-ROW SAFETY: candidate discovery is global, but each
 * terminal write is routed through the linked transaction coordinator under
 * that row's session control lock. This is required for `wallet_transfer`,
 * whose AA row is linked to a live `wallet_intents` row. A bulk AA-only UPDATE
 * could remove the activity from every repair candidate while leaving its
 * linked intent and protocol execution live forever.
 *
 * The winning per-row CAS retains `tx_hash IS NULL`. Candidate discovery is
 * not authority: if signing stages a hash after discovery, the terminal CAS
 * misses and the staged row stays pending for its chain observer.
 */

import { query } from "../../client.js";

import { settleLinkedActivityRows } from "./linked-transaction-settlement.js";
import { failHashlessActivityEventWith } from "./swap-lifecycle/terminal-cas.js";
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
  // `bridge_fee` (migration 050) is the Vex integrator-fee transfer — the FINAL
  // Vex-signed origin leg. It was recorded as `allowance` before 050 and was
  // therefore already reapable through this allowlist; giving it its own role
  // must NOT quietly remove that. A fee leg planned but never signed (the
  // bridge aborted, or the process died between intent creation and staging) is
  // exactly "definitely not attempted", and leaving it pending would also pin
  // the session's bridge in-flight slot open.
  "bridge_fee",
  // `trench_fee` (migration 063) is the SAME kind of leg on Trench Express —
  // the final Vex-signed leg, run only after the trade or launch confirmed. A
  // fee leg planned but never signed (the trade reverted, or the process died
  // between intent creation and staging) is definitively not-attempted, so it
  // must stay reapable here rather than sit pending forever.
  "trench_fee",
  // `swap_fee` (migration 066) is the same leg again, on a swap venue whose
  // router takes no fee parameter (Uniswap): the final Vex-signed transfer, run
  // only after the swap confirmed. Planned-but-never-signed — the swap reverted,
  // was ambiguous, or the process died between intent creation and staging — is
  // definitively not-attempted, so it stays reapable here.
  "swap_fee",
  // `pools_fee` (migration 082) is the same leg once more, on pools.fun. Note
  // that `pools_claim` is deliberately NOT here: a claim is the PRIMARY
  // transaction of its own execution, not a dependent leg that a failed parent
  // proves was never attempted.
  "pools_fee",
  "allowance",
  "allowance_reset",
  "lend_deposit",
  "lend_withdraw",
  "lend_borrow_operate",
  "predict_buy",
  "predict_sell",
  "predict_claim",
  "predict_close",
  // Migration 053 (Pendle). Every one of the six is signed LOCALLY through the
  // single `pendle/handlers/signed-broadcast.ts` choke point, exactly like the
  // roles above, and NO Pendle-side sweep owns a hashless row: the EVM repair
  // sweep's candidate query requires `submit_attempted_at IS NOT NULL`, which
  // only `markActivityBroadcast` sets. Omitting them here would leave a row
  // created between intent and staging (a crash, a CAS-miss refusal) pending
  // forever — the exact hole this allowlist exists to close.
  "yield_pt",
  "yield_yt",
  "yield_py",
  "yield_lp",
  "yield_sy",
  "yield_claim",
  // Migration 062 (Trench Express launch). Signed LOCALLY through the launch
  // handler's `signStageBroadcast` choke point, exactly like the roles above,
  // and no Trench-side sweep owns a hashless row: the EVM repair sweep's
  // candidate query requires `submit_attempted_at IS NOT NULL`, which only
  // `markActivityBroadcast` sets. A row created between intent and staging (a
  // crash, a CAS-miss refusal, an image the resolver could not produce) would
  // otherwise stay pending forever — the exact hole this allowlist closes.
  //
  // Safe because "never signed" is itself definitive: this CAS predicate
  // (`status='pending' AND tx_hash IS NULL`) is the SAME one
  // `markActivityBroadcast` needs to succeed, so if the signer wins the race
  // this sweep finds nothing, and if the sweep wins the signer's own CAS misses
  // and it aborts before broadcasting. A launch can never be double-created by
  // this interaction.
  "token_launch",
  // Migration 084 (agent wallet send). Signed LOCALLY through the wallet send
  // executors' staged writer (`internal/wallet/send/activity-writer.ts`), on
  // either chain family, and no wallet-side sweep owns a hashless row: the EVM
  // repair sweep's candidate query requires `submit_attempted_at IS NOT NULL`,
  // which only `markActivityBroadcast` sets.
  //
  // Safe for the same reason `token_launch` is, plus one specific to this lane:
  // the transfer writer stages the hash BEFORE it submits the signed bytes, so
  // `tx_hash IS NULL` on a transfer row is proof that nothing was ever sent to
  // the network. A crash between intent creation and staging is reaped here
  // instead of pinning the session's money state open forever.
  "wallet_transfer",
  // Migration 088 (the generic EVM signing lane's Vex fee). The same dependent
  // fee leg once more: created `pending` and hashless inside the T2 claim, and
  // signed only if the transaction it charges for confirms. Every arm on which
  // it is never signed - the transaction reverted, was ambiguous, was refused at
  // a fence, or the process died - finalizes it best-effort at return time, and
  // this sweep is the backstop for the arm where that write itself did not land.
  //
  // Safe for the reason every other role here is: the CAS predicate
  // (`status='pending' AND tx_hash IS NULL`) is the SAME one
  // `markActivityBroadcast` needs, so a staged fee leg is invisible to this
  // sweep and a reaped one can no longer be broadcast.
  "tx_vex_fee",
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
 * periodic tick. Returns every row this invocation finalized, mapped. A row
 * staged or terminalized after discovery is omitted rather than claimed by
 * this sweep.
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
  const candidates = await query<{ id: string | number; session_id: string | null }>(
    `SELECT id, session_id
       FROM agent_activity
      WHERE status = 'pending' AND tx_hash IS NULL
        AND event_role = ANY($3::text[])
        AND created_at < NOW() - make_interval(secs => $1::float8)
      ORDER BY created_at ASC
      LIMIT $2`,
    [leaseMs / 1000, limit, LOCALLY_SIGNABLE_ACTIVITY_ROLES],
  );

  const finalized: AgentActivityEvent[] = [];
  for (const candidate of candidates) {
    const activityId = Number(candidate.id);
    if (!Number.isSafeInteger(activityId)) {
      throw new Error("agent_activity: stale hashless candidate id is not a safe integer");
    }
    const result = await settleLinkedActivityRows({
      activityId,
      sessionId: candidate.session_id,
      intentOutcome: "crashed_before_broadcast",
      activityTarget: { status: "definitively_failed", failureCode: "unknown" },
      activityWrite: (client) => failHashlessActivityEventWith(client, activityId, {
        failureCode: "unknown",
        failureReason: "not attempted: stale hashless intent - never signed within the recovery lease",
      }),
    });
    if (result.applied) finalized.push(result.row);
  }
  return finalized;
}
