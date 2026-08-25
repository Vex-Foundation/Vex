/**
 * Agent Scan activity repo — staged broadcast, CAS finalize, and reads for
 * `agent_activity` (migration `044_agent_activity.sql`; FIX-SPINE round 1
 * hardened the CAS/conditional-state contract per Codex findings 3/5/6/7/9;
 * FIX2-SPINE round 2 added `abortPlannedEvents` per Codex final-review
 * finding 3/C17).
 *
 * Steps 2-4 of the write protocol whose full contract is documented on the
 * sibling `./swap-intent.js` (step 1: pre-broadcast intent creation) — see
 * that file's module doc for the numbered `createAgentActivityIntent` →
 * `markActivityBroadcast` → `markBroadcastAccepted` →
 * `confirmActivityEvent`/`failActivityEvent` sequence every venue handler
 * MUST follow. Every finalizing function here is a CAS write — `WHERE
 * status = 'pending'` — never an unconditional one, and every one returns
 * `{applied, row}` so a caller can tell "I finalized this" from "this was
 * already finalized" (finding 6/C7).
 *
 * These primitives are reused VERBATIM by the bridge API (`./bridge.js`,
 * migration 045, R4) for its Vex-signed legs — they are kind-agnostic CAS
 * writes, not swap-only by SQL shape.
 *
 * W5 Solana staged seam (design `w5-design.md` §2/R2/R2b/R2c, migration 049):
 * `src/tools/solana-ecosystem/shared/solana-transaction/prepare.js`'s
 * `prepareVersionedTx` replaces "sign and send monolithically" with
 * sign-only; the caller persists the derived signature + blockhash evidence
 * via `markActivitySolanaBroadcast` BEFORE calling `submitPreparedTx`
 * (`jupiter-swaps/submit-prepared-tx.js`, `/tx/v1/submit` ONLY). A throw from
 * `prepareVersionedTx` (deserialize failure, the strict sole-signer check, or
 * a blockhash-evidence mismatch) happens AFTER `createAgentActivityIntent`
 * already created the pending row(s) — it is a POST-INTENT failure, so the
 * caller finalizes via `failActivityEvent`/`abortPlannedEvents` below, NEVER
 * `createAgentActivityPreBroadcastFailure` (which would create a duplicate
 * `protocol_executions` row for the same attempt).
 *
 * The stale hashless-intent WALL-CLOCK recovery sweep (`recoverStale-
 * HashlessIntents`) lives in the sibling `./hashless-recovery.js` (C7
 * extraction) — see that module's doc for the family-agnostic recovery
 * contract. The READ queries live in `./swap-lifecycle/reads.js` and are
 * re-exported from here unchanged.
 */

import { queryOne, queryOneWith, queryWith } from "../../client.js";
import {
  resolveActivitySessionByExecutionId,
  resolveActivitySessionByRowId,
  withActivitySessionLock,
} from "./session-lock.js";

import { assertFailureCode, sanitizeFailureReason } from "./validation.js";
import { mapRow } from "./mappers.js";
import type { AgentActivityEvent, AgentActivityFailureCode, CasResult } from "./types.js";
import type { ConfirmationSource } from "./provenance-vocabulary.js";
import { armFastLane, resolveFastLane } from "./fast-lane-signal.js";
import { settleLinkedActivityRowsWith } from "./linked-transaction-settlement.js";
import logger from "@utils/logger.js";

// ── Types (swap-only inputs) ─────────────────────────────────────────

export interface MarkActivityBroadcastInput {
  txHash: string;
  fromAddress: string;
  nonce: number;
}

// ── Staged broadcast persistence ────────────────────────────────────

/**
 * Persist the SIGNED tx hash BEFORE the RPC submit call after the nonce was
 * durably reserved on this same row before signing. CAS-guarded
 * `WHERE status='pending' AND tx_hash IS NULL`
 * (FIX-SPINE C6 — finding 5) — a repair-sweep, a retry, or a duplicate call
 * can NEVER overwrite an already-staged hash; `applied:false` signals the
 * miss instead.
 */
export async function markActivityBroadcast(
  id: number,
  input: MarkActivityBroadcastInput,
): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3, nonce = $4,
            submit_attempted_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
        AND chain_family = 'eip155'
        AND (
          (lower(from_address) = lower($3) AND nonce = $4)
          OR (from_address IS NULL AND nonce IS NULL)
        )
      RETURNING *`,
    [id, input.txHash, input.fromAddress, input.nonce],
  );
  if (row) return { applied: true, row: mapRow(row) };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markActivityBroadcast") };
}

/**
 * Solana staging variant of `markActivityBroadcast` (B1 nonce matrix): a
 * Vex-signed Solana leg stages its base58 SIGNATURE in `tx_hash` (the Khalani
 * API contract carries signatures in the hash field) with `nonce` left NULL —
 * the 045 `agent_activity_solana_no_nonce` CHECK forbids a Solana nonce. The
 * `chain_family='solana'` predicate makes misuse on an EVM row a CAS miss
 * (`applied:false`), never a wrongly-shaped stage.
 *
 * W5 (design §2/R2, migration 049): the blockhash EVIDENCE `prepareVersionedTx`
 * derives (VERIFY or REPLACE mode — see that module's doc) is persisted in the
 * SAME atomic CAS as the signature, never a separate write — `recentBlockhash`
 * + `lastValidBlockHeight` are REQUIRED here because the 049
 * `agent_activity_solana_staged_has_evidence` CHECK requires both NOT NULL the
 * moment `submit_attempted_at` is set on a `chain_family='solana'` row. A
 * caller that stages a Solana row WITHOUT going through `prepareVersionedTx`
 * (i.e. without real evidence) will fail this CHECK at the DB layer — that is
 * the CHECK doing its job, not a bug in this function.
 */
export async function markActivitySolanaBroadcast(
  id: number,
  input: {
    readonly txHash: string;
    readonly fromAddress: string;
    readonly recentBlockhash: string;
    readonly lastValidBlockHeight: number;
  },
): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    // Migration 067: a Solana row is awaiting confirmation from the moment its
    // signature is staged. Written HERE, in the one statement every Solana
    // handler already funnels through, rather than repeated at four submit
    // sites — Solana has no receipt to read at return, so this is the ONLY
    // reason a locally-staged Solana row is ever pending, and a per-handler
    // variant would have nothing different to say. `COALESCE` keeps it
    // write-once, matching `notePendingReason`'s handler contract.
    `UPDATE agent_activity
        SET tx_hash = $2, from_address = $3,
            recent_blockhash = $4, last_valid_block_height = $5,
            submit_attempted_at = NOW(), updated_at = NOW(),
            pending_reason = COALESCE(pending_reason, 'solana_awaiting_confirmation')
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NULL
        AND chain_family = 'solana'
      RETURNING *`,
    [id, input.txHash, input.fromAddress, input.recentBlockhash, input.lastValidBlockHeight],
  );
  if (row) return { applied: true, row: armFastLane(mapRow(row), "onchain") };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markActivitySolanaBroadcast") };
}

/**
 * Stamp `broadcast_at` once the RPC has actually accepted the submission.
 * CAS-guarded `WHERE status='pending' AND tx_hash IS NOT NULL AND
 * broadcast_at IS NULL` (FIX-SPINE C6 — finding 5): cannot run before a hash
 * was staged, cannot run twice.
 */
export async function markBroadcastAccepted(id: number): Promise<CasResult> {
  const row = await queryOne<Record<string, unknown>>(
    `UPDATE agent_activity
        SET broadcast_at = NOW(), updated_at = NOW()
      WHERE id = $1 AND status = 'pending' AND tx_hash IS NOT NULL AND broadcast_at IS NULL
      RETURNING *`,
    [id],
  );
  if (row) return { applied: true, row: armFastLane(mapRow(row), "onchain") };
  return { applied: false, row: await getCurrentRowOrThrow(id, "markBroadcastAccepted") };
}

/**
 * Early-plan-abort finalize (FIX2-SPINE C17 — Codex final-review finding
 * 3): when an upstream leg of a multi-event execution reverts or ends
 * ambiguously, every DOWNSTREAM row that is still `pending` AND was NEVER
 * signed (`tx_hash IS NULL`) is CAS-finalized to `definitively_failed` in one
 * sweep. "Not attempted" is itself a definitive outcome — nothing was ever
 * broadcast for these rows — so this does NOT reopen "ambiguity never
 * terminalizes" (C1): that rule protects a row whose OWN signed submission
 * has an uncertain outcome, never a row that was never signed to begin with.
 * A row that already has a `tx_hash` staged is left untouched — its own
 * repair-sweep path (C1/`agent-activity-repair.ts`) owns finalizing it, since
 * ITS submission may still be in flight or mined.
 *
 * Venue handlers call this on EVERY early return (upstream revert/ambiguity)
 * and in the outer catch (§11.1/C18 — the outer catch must finalize existing
 * rows, never create a second execution). `fromIndex` is the first
 * not-yet-attempted `event_index` in the plan; every row at or after it is a
 * candidate. Never throws for "nothing qualified" — returns `[]`.
 *
 * `listPendingOlderThan` can never pick up a row this function is meant to
 * catch in the interim: that sweep query requires `submit_attempted_at IS NOT
 * NULL`, and `submit_attempted_at` is set ONLY by `markActivityBroadcast`
 * (step 2) — a never-signed row has no `submit_attempted_at`, so it is not a
 * repair-sweep candidate regardless of how long it sits `pending` before this
 * function (or a crash) finalizes or abandons it.
 *
 * `toIndexExclusive` (FIX-ROUND-1 blocker 1, granted minimal widening) bounds the
 * abort to `event_index < toIndexExclusive` so a caller can abort never-signed
 * sibling legs WITHOUT terminalizing a higher-indexed row it must leave pending —
 * specifically the logical `bridge_fill_expected` row after an AMBIGUOUS deposit,
 * whose in-flight guard + W4 null-order-id recovery require it to stay `pending`
 * (aborting it would release the guard while the deposit may have landed, enabling
 * a duplicate bridge). Omitted → the bound is a no-op and the range is `>=
 * fromIndex` exactly as before (every existing caller is byte-unaffected). The
 * bound cannot express what the existing `fromIndex`-only range could, and does
 * not touch any CHECK.
 *
 * INT-TEST NOTE (FIX-A → coordinator/W-SPINE): the CAS suite for the bridge repo
 * (`integration/agent-scan/bridge-cas.int.test.ts`) should gain a case proving
 * `abortPlannedEvents(exec, depositIndex+1, reason, expectedFillIndex)` finalizes
 * the never-signed sibling legs while leaving the `bridge_fill_expected` row
 * `pending` (its `event_index === toIndexExclusive` is excluded).
 */
export async function abortPlannedEvents(
  executionId: number,
  fromIndex: number,
  reason: string,
  toIndexExclusive?: number,
): Promise<AgentActivityEvent[]> {
  // Under the session control lock. Every row of one `protocol_execution_id`
  // belongs to the same session, so a single key covers this multi-row CAS.
  const sessionId = await resolveActivitySessionByExecutionId(executionId);
  return withActivitySessionLock(sessionId, async (client) => {
    const rawRows = await queryWith<Record<string, unknown>>(
      client,
      `UPDATE agent_activity
          SET status = 'definitively_failed', failure_code = 'unknown',
              failure_reason = $3, updated_at = NOW(), pending_reason = NULL
        WHERE protocol_execution_id = $1 AND event_index >= $2
          AND ($4::int IS NULL OR event_index < $4::int)
          AND status = 'pending' AND tx_hash IS NULL
        RETURNING *`,
      // C17: the stored reason is ALWAYS prefixed "not attempted:" - a single
      // enforcement point, whatever wording the venue caller passed in.
      [executionId, fromIndex, sanitizeFailureReason(`not attempted: ${reason}`), toIndexExclusive ?? null],
    );
    const rows = rawRows.map(mapRow);

    // The bulk AA update and every linked WI/WTI/PE transition share this
    // transaction. A conflict in any linked state rolls the complete abort
    // back, so no terminal activity row can escape without its durable owner.
    for (const row of rows) {
      await settleLinkedActivityRowsWith(client, {
        activityId: row.id,
        sessionId: row.sessionId,
        intentOutcome: "crashed_before_broadcast",
        activityTarget: { status: "definitively_failed", failureCode: "unknown" },
        activityWrite: () => Promise.resolve({ applied: false, row }),
      });
    }
    return rows;
  });
}

// Stale hashless-intent recovery (`recoverStaleHashlessIntents`,
// `HASHLESS_INTENT_RECOVERY_LEASE_MS`) moved to the sibling
// `./hashless-recovery.js` (C7 extraction, kept this file under the repo's
// 500-line file cap) — a wall-clock sweep primitive with its own reason to
// change (recovery policy for abandoned-before-staging rows), distinct from
// the in-execution CAS transitions above. Re-exported unchanged from the
// top-level `agent-activity.ts` facade.

// The verification-bookkeeping family (`touchLastChecked`,
// `clearVerificationStall`) lives in the sibling
// `./swap-lifecycle/verification-bookkeeping.js` — what we currently KNOW about
// a still-`pending` row is a different reason to change from this file's
// once-only CAS state transitions, and the same argument the fast-lane
// signalling and the read queries were split out on. RE-EXPORTED here so every
// existing import site is byte-unaffected.
export type {
  PendingReasonContext,
  NotePendingReasonMiss,
} from "./swap-lifecycle/verification-bookkeeping.js";
export {
  touchLastChecked,
  clearVerificationStall,
  notePendingReason,
} from "./swap-lifecycle/verification-bookkeeping.js";

// Fast-lane arm/resolve emits live in the sibling `./fast-lane-signal.js` — the
// same helpers are needed by `./bridge-lifecycle.ts` and `./launch-lifecycle.ts`,
// and the signalling contract is a different reason to change than this file's
// CAS state transitions.

// ── Terminal CAS finalize ────────────────────────────────────────

// The terminalizing CAS writers, the claim fence they run under, and the
// per-role confirmed-leg guards live in the sibling `./swap-lifecycle/
// terminal-cas.js` (move-only extraction). Different reason to change from this
// file's staging transitions: WHO may terminalize a row and under what fence.
// RE-EXPORTED here so every existing import site is byte-unaffected; the
// `...With` twins are the addition that lets a caller terminalize several
// coupled rows inside ONE transaction.
export type {
  ConfirmActivityEventInput,
  FailActivityEventInput,
  TerminalWriteContext,
  TerminalCasResult,
} from "./swap-lifecycle/terminal-cas.js";
export {
  confirmActivityEvent,
  confirmActivityEventWith,
  confirmActivityEventStatusOnly,
  confirmActivityEventStatusOnlyWith,
  failActivityEvent,
  failActivityEventWith,
  failHashlessActivityEventWith,
} from "./swap-lifecycle/terminal-cas.js";

// ── Reads ─────────────────────────────────────────────────────────

// The read queries (`getActivityEventById`, the two repair-sweep candidate
// sets, the Agent Scan feed page, `existsForExecutionId`) live in the sibling
// `./swap-lifecycle/reads.js` — a different reason to change (candidate
// ordering, filters, pagination) from this file's CAS state transitions, and
// the headroom this file needed under the repo's 550-line hard limit.
// RE-EXPORTED here so every existing import site is byte-unaffected.
export type { ListActivityFeedOptions } from "./swap-lifecycle/reads.js";
export {
  getActivityEventById,
  getActivityEventByIdWith,
  listPendingOlderThan,
  listPendingByIds,
  listPendingProviderLogical,
  hasPendingActivityForWallets,
  listSolanaStagedPending,
  listActivityFeed,
  existsForExecutionId,
} from "./swap-lifecycle/reads.js";

import { getActivityEventById } from "./swap-lifecycle/reads.js";

// ── Internal helpers ─────────────────────────────────────────────────

/** A CAS write missed (row already terminal, or the id genuinely does not exist). */
async function getCurrentRowOrThrow(id: number, caller: string): Promise<AgentActivityEvent> {
  const current = await getActivityEventById(id);
  if (!current) {
    throw new Error(`agent_activity: ${caller} — row ${id} does not exist`);
  }
  return current;
}
