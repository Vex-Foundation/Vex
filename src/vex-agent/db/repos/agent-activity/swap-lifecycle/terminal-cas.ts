/**
 * The TERMINALIZING CAS writers for `agent_activity` - `confirmActivityEvent`,
 * `confirmActivityEventStatusOnly` and `failActivityEvent` - together with the
 * claim fence that guards them and the per-role confirmed-leg guards.
 *
 * MOVE-ONLY extraction from the sibling `../swap-lifecycle.ts` (which keeps its
 * name and re-exports every symbol here unchanged, so no import site moved),
 * plus ONE addition: each terminal writer now has a CLIENT-BOUND twin.
 *
 * ## Why the client-bound twin exists
 *
 * The pool-level functions open their OWN transaction and take the session
 * control lock inside it. When the activity belongs to a generic transaction
 * intent, that transaction also settles the linked WTI and PE rows through the
 * coordinator in `../linked-transaction-settlement.ts`. It is still WRONG for
 * a caller that already owns a wider settlement transaction to nest a
 * pool-level write: the new connection could not see uncommitted sibling rows
 * and could not roll back with them.
 *
 * So the twin does exactly the same AA CAS, the same fence, and the same
 * `{applied, row}` reporting on the CALLER's client, including the miss read.
 * The caller owns every linked sibling write in that case.
 *
 * The two arms share one implementation, so the CAS predicate, the guards and
 * the fence can never drift apart between them.
 */

import type { PoolClient } from "pg";

import { queryOneWith } from "../../../client.js";
import { withActivitySessionLock, resolveActivitySessionByRowId } from "../session-lock.js";
import { assertFailureCode, sanitizeFailureReason } from "../validation.js";
import { mapRow } from "../mappers.js";
import type { AgentActivityEvent, AgentActivityFailureCode, CasResult } from "../types.js";
import type { ConfirmationSource } from "../provenance-vocabulary.js";
import { resolveFastLane } from "../fast-lane-signal.js";
import { getActivityEventById, getActivityEventByIdWith } from "./reads.js";
import {
  settleLinkedActivityRows,
  type LinkedIntentRepairOutcome,
} from "../linked-transaction-settlement.js";
import logger from "@utils/logger.js";

/**
 * WHERE the write runs. `null` means "own transaction, own lock" (the pool-level
 * arm); a client means "the caller's transaction, whose lock is already held".
 */
type WriteConnection = PoolClient | null;

/** The current row, read on the SAME connection the write ran on. */
async function readCurrentRow(
  conn: WriteConnection,
  id: number,
): Promise<AgentActivityEvent | null> {
  return conn === null ? getActivityEventById(id) : getActivityEventByIdWith(conn, id);
}

/**
 * Run one terminalizing CAS. On the pool-level arm it opens a transaction and
 * takes the session control lock; on the client-bound arm it runs the identical
 * statement on the caller's client, which already holds both.
 */
async function runTerminalCas(
  conn: WriteConnection,
  sessionIdForLock: () => Promise<string | null>,
  sql: string,
  params: unknown[],
): Promise<Record<string, unknown> | null> {
  if (conn !== null) return queryOneWith<Record<string, unknown>>(conn, sql, params);
  const sessionId = await sessionIdForLock();
  return withActivitySessionLock(sessionId, (client) =>
    queryOneWith<Record<string, unknown>>(client, sql, params));
}

// ── Types (swap-only inputs) ─────────────────────────────────────────

export interface ConfirmActivityEventInput {
  executedAmountInHuman?: string;
  executedAmountInRaw?: string;
  executedAmountOutHuman?: string;
  executedAmountOutRaw?: string;
  /** Option-C executed second legs (migration 053) - see `assertYieldConfirmLegs`. */
  executedAmountIn2Human?: string;
  executedAmountIn2Raw?: string;
  executedAmountOut2Human?: string;
  executedAmountOut2Raw?: string;
}

export interface FailActivityEventInput {
  failureCode: AgentActivityFailureCode;
  failureReason: string;
}
// ── The claim fence on the terminal CASes ────────────────────────────

/**
 * WHERE a terminalizing CAS is being called from, and therefore which extra
 * clause guards it. A DISCRIMINATED UNION, not an optional token, so a
 * claim-window caller cannot forget the fence and a venue handler is not asked
 * for a token it cannot have.
 *
 * WHY A TERMINAL WRITE NEEDS A FENCE AT ALL - the counterexample is this
 * repository's own reported bug. A terminalizing CAS writes an immutable chain
 * fact, so a stale write is still TRUE; what that misses is that the CAS is
 * ONCE-ONLY, so whoever wins it locks everyone else out - and the stale winner
 * can be writing the WEAKER truth:
 *
 *   Claim A expires mid-RPC; claim B is acquired legitimately. Stale worker A
 *   returns and wins `WHERE status = 'pending'` with
 *   `confirmActivityEventStatusOnly` - status confirmed, NO amounts. The venue
 *   handler then arrives with DECODED amounts and misses the CAS, because the
 *   row is no longer pending. Result: `confirmed` + `amountBasis: "estimated"` +
 *   `executedAmount* = null` - exactly the row the owner reported, re-created by
 *   the concurrency design.
 *
 * The `handler_return` branch keeps today's CAS byte-for-byte, and that is a
 * REQUIREMENT, not an implementation detail: applying the token predicate to
 * BOTH variants (the natural mistake when adding one `AND` to a shared
 * statement) would make a venue handler lose its exact amounts merely because
 * the fallback lane happens to hold a lease - the same amountless-confirmed row,
 * reached from the opposite direction.
 *
 * `evm_claim_token` is the pending-fallback workstream's column (its migration
 * `068`); it is referenced ONLY in the `claim` branch, so this file is
 * unaffected until that lane exists.
 */
export type TerminalWriteContext =
  | { readonly kind: "handler_return" }
  | { readonly kind: "claim"; readonly claimToken: string };

/** `CasResult` plus the one miss a fenced writer can report. */
export type TerminalCasResult = CasResult & { reason?: "claim_lost" };

const HANDLER_RETURN: TerminalWriteContext = { kind: "handler_return" };

/** The extra CAS clause and its bound parameter for a given context. */
function claimFence(
  context: TerminalWriteContext,
  nextParamIndex: number,
): { clause: string; params: readonly string[] } {
  if (context.kind === "claim") {
    return { clause: ` AND evm_claim_token = $${nextParamIndex}`, params: [context.claimToken] };
  }
  return { clause: "", params: [] };
}

/**
 * A fenced terminal CAS wrote zero rows. Distinguishes "someone else already
 * terminalized this" from "my claim expired" - the caller must not retry blind.
 */
async function terminalMiss(
  conn: WriteConnection,
  id: number,
  caller: string,
  context: TerminalWriteContext,
): Promise<TerminalCasResult> {
  const current = await readCurrentRow(conn, id);
  if (current === null) {
    throw new Error(`agent_activity: ${caller} - row ${id} does not exist`);
  }
  if (context.kind === "claim" && current.status === "pending") {
    // The fallback lane's own event name, emitted here because this is the write
    // site that observes the zero-row result. Expected under load, not an error.
    logger.debug("sync.evm_claim.lost", { id, caller });
    return { applied: false, row: current, reason: "claim_lost" };
  }
  return { applied: false, row: current };
}

// ── CAS finalize ─────────────────────────────────────────────────────

/**
 * `pending -> confirmed`. CAS-guarded; returns `{applied, row}` (FIX-SPINE
 * C7 - finding 6) so a caller (notably the repair sweep, which can race a
 * concurrent finalize) can tell "I just confirmed this" from "this was
 * already confirmed" instead of treating both identically.
 *
 * `event_role='swap'` REQUIRES both executed amounts (FIX-SPINE C8 - finding
 * 3): the row's OWN `event_role` is read first (never trusted from the
 * caller) and validated before the UPDATE is attempted - the DB's
 * `agent_activity_confirmed_swap_has_executed_legs` CHECK is the
 * belt-and-suspenders backstop if this repo function is ever bypassed.
 */
export async function confirmActivityEvent(
  id: number,
  input: ConfirmActivityEventInput,
  context: TerminalWriteContext = HANDLER_RETURN,
): Promise<TerminalCasResult> {
  const sessionId = await resolveActivitySessionByRowId(id);
  return settleLinkedActivityRows({
    activityId: id,
    sessionId,
    intentOutcome: "confirmed",
    activityTarget: { status: "confirmed" },
    activityWrite: (client) => runConfirmActivityEvent(client, id, input, context),
  });
}

/**
 * `confirmActivityEvent` on the CALLER's transaction and lock. Identical CAS,
 * identical guards, identical `{applied, row}` contract; the miss read comes
 * from the same client so it reports the row as the caller's transaction sees
 * it. See this module's header for why a nested pool-level write is wrong.
 */
export async function confirmActivityEventWith(
  client: PoolClient,
  id: number,
  input: ConfirmActivityEventInput,
  context: TerminalWriteContext = HANDLER_RETURN,
): Promise<TerminalCasResult> {
  return runConfirmActivityEvent(client, id, input, context);
}

async function runConfirmActivityEvent(
  conn: WriteConnection,
  id: number,
  input: ConfirmActivityEventInput,
  context: TerminalWriteContext,
): Promise<TerminalCasResult> {
  const current = await readCurrentRow(conn, id);
  if (!current) {
    throw new Error(`agent_activity: confirmActivityEvent - row ${id} does not exist`);
  }
  if (current.eventRole === "swap"
    && (!input.executedAmountInRaw || !input.executedAmountOutRaw)) {
    throw new Error(
      "agent_activity: confirmActivityEvent - event_role 'swap' requires "
        + "executedAmountInRaw + executedAmountOutRaw",
    );
  }
  if ((current.eventRole === "wrap" || current.eventRole === "unwrap")
    && (!input.executedAmountInRaw || !input.executedAmountOutRaw)) {
    // Migration 061 drops `agent_activity_confirmed_wrap_has_executed_legs`
    // (confirmed-without-executed-amounts is now a legitimate state for the
    // status-only repair path). That CHECK was wrap/unwrap's ONLY strict
    // invariant - this guard replaces it as the enforcement point, so the
    // relaxation reaches exactly one caller: `confirmActivityEventStatusOnly`.
    throw new Error(
      "agent_activity: confirmActivityEvent - event_role 'wrap'/'unwrap' requires "
        + "executedAmountInRaw + executedAmountOutRaw",
    );
  }
  if (current.eventRole === "token_launch"
    && (!input.executedAmountInRaw || !input.executedAmountOutRaw)) {
    // Migration 062 deliberately adds NO confirmed-legs CHECK for `launch` -
    // 061 dropped the three that existed because status-only repair makes
    // `confirmed` + NULL `executed_*` a legitimate reachable state, and a new
    // one would forbid exactly the rows that sweep must write. So this guard IS
    // the strict path's enforcement point, and the relaxation reaches exactly
    // one caller: `confirmActivityEventStatusOnly`.
    //
    // Both legs are required because a launch that mined successfully always has
    // both: the native `msg.value` spent (creation fee + prebuy) and the token
    // that `TokenCreated` proves now exists. A handler decoding its own receipt
    // can read both; one that cannot has not proven the launch settled and must
    // leave the row pending for the repair sweep rather than confirm it half-known.
    throw new Error(
      "agent_activity: confirmActivityEvent - event_role 'token_launch' requires "
        + "executedAmountInRaw + executedAmountOutRaw",
    );
  }
  assertYieldConfirmLegs(current, input);
  // Under the session control lock: `pending` is money state the compaction
  // safe-moment gate reads. `current` is the pre-read this function already
  // does, so the session key costs no extra round trip. DB-only - the receipt
  // lookup that produced these amounts finished before this call.
  // Migration 067: this confirmation was established by decoding our OWN receipt
  // at return time, so BOTH provenance columns say `tool_response` - but the
  // settlement half only where amounts were actually written, because a caller
  // that supplied none has proven nothing about the money. `pending_reason` is
  // cleared: a terminal row must never store a reason it "is pending".
  const fence = claimFence(context, 10);
  const currentSessionId = current.sessionId;
  const row = await runTerminalCas(
    conn,
    async () => currentSessionId,
    `UPDATE agent_activity
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(),
            executed_amount_in_human = $2, executed_amount_in_raw = $3,
            executed_amount_out_human = $4, executed_amount_out_raw = $5,
            executed_amount_in2_human = $6, executed_amount_in2_raw = $7,
            executed_amount_out2_human = $8, executed_amount_out2_raw = $9,
            confirmation_source = 'tool_response',
            settlement_source = CASE WHEN $3::text IS NOT NULL OR $5::text IS NOT NULL
                                     THEN 'tool_response' ELSE settlement_source END,
            pending_reason = NULL,
            -- A TERMINAL ROW HOLDS NO CLAIM. Cleared in the WINNING update
            -- itself, never in a follow-up statement: the resolver deliberately
            -- skips releaseEvmClaim after a terminal outcome, so a second
            -- statement that got interrupted would leave the row terminal WITH a
            -- live lease and token - state that outlives the thing it describes
            -- and that a late worker could still try to act on.
            evm_claim_lease_until = NULL, evm_claim_token = NULL
      WHERE id = $1 AND status = 'pending'${fence.clause}
      RETURNING *`,
    [
      id,
      input.executedAmountInHuman ?? null,
      input.executedAmountInRaw ?? null,
      input.executedAmountOutHuman ?? null,
      input.executedAmountOutRaw ?? null,
      input.executedAmountIn2Human ?? null,
      input.executedAmountIn2Raw ?? null,
      input.executedAmountOut2Human ?? null,
      input.executedAmountOut2Raw ?? null,
      ...fence.params,
    ],
  );
  if (row) return { applied: true, row: resolveFastLane(mapRow(row)) };
  return terminalMiss(conn, id, "confirmActivityEvent", context);
}

/**
 * `pending -> confirmed` WITHOUT any amount (owner decree 2026-07-30) - the
 * repair sweeps' own finalizer, and the ONE deliberate bypass of the strict
 * per-role amount guards above.
 *
 * The sweeps are status-only: they ask the chain whether a tx hash succeeded or
 * reverted and nothing else. So they can prove a transaction SETTLED without
 * being able to prove WHAT it moved. Writing the quoted amounts into
 * `executed_*` would record a quote as a settlement - the single thing the
 * money-path rules forbid - so this function writes NO amount column at all and
 * leaves `executed_*` NULL. Agent Scan renders such a row's quoted amount
 * explicitly labelled "estimated" (`agent-activity-amount.ts`).
 *
 * Everything else matches `confirmActivityEvent`: the same
 * `WHERE status = 'pending'` CAS, the same `withActivitySessionLock` (this is
 * money state the compaction safe-moment gate reads), the same `{applied, row}`
 * contract so a caller can tell "I confirmed this" from "someone already did".
 *
 * NOT for venue handlers. A broadcast handler decodes its own receipt and MUST
 * use `confirmActivityEvent`, whose guards are unchanged.
 *
 * `source` (migration 067) is CALLER-SUPPLIED and a closed union, because both
 * sweeps call this: the EVM sweep reads a receipt, the Solana sweep reads a
 * SIGNATURE STATUS and never a receipt at all. A hardcoded `receipt_status_only`
 * would be factually wrong on every Solana row.
 */
export async function confirmActivityEventStatusOnly(
  id: number,
  source: Extract<ConfirmationSource, "receipt_status_only_evm" | "receipt_status_only_solana">,
  context: TerminalWriteContext = HANDLER_RETURN,
): Promise<TerminalCasResult> {
  const sessionId = await resolveActivitySessionByRowId(id);
  return settleLinkedActivityRows({
    activityId: id,
    sessionId,
    intentOutcome: "confirmed",
    activityTarget: { status: "confirmed" },
    activityWrite: (client) => runConfirmActivityEventStatusOnly(client, id, source, context),
  });
}

/** Status-only confirmation on the caller's existing transaction and lock. */
export async function confirmActivityEventStatusOnlyWith(
  client: PoolClient,
  id: number,
  source: Extract<ConfirmationSource, "receipt_status_only_evm" | "receipt_status_only_solana">,
  context: TerminalWriteContext = HANDLER_RETURN,
): Promise<TerminalCasResult> {
  return runConfirmActivityEventStatusOnly(client, id, source, context);
}

async function runConfirmActivityEventStatusOnly(
  conn: WriteConnection,
  id: number,
  source: Extract<ConfirmationSource, "receipt_status_only_evm" | "receipt_status_only_solana">,
  context: TerminalWriteContext,
): Promise<TerminalCasResult> {
  const fence = claimFence(context, 3);
  // `settlement_source` is deliberately UNTOUCHED: this sweep proved inclusion
  // and learned nothing whatsoever about the amounts, so it has no business
  // stating how they were established - that is a separate fact with its own
  // writer, and a late decode must still be able to record it.
  const row = await runTerminalCas(
    conn,
    () => resolveActivitySessionByRowId(id),
      `UPDATE agent_activity
        SET status = 'confirmed', confirmed_at = NOW(), updated_at = NOW(),
            confirmation_source = $2, pending_reason = NULL,
            -- A TERMINAL ROW HOLDS NO CLAIM. Cleared in the WINNING update
            -- itself, never in a follow-up statement: the resolver deliberately
            -- skips releaseEvmClaim after a terminal outcome, so a second
            -- statement that got interrupted would leave the row terminal WITH a
            -- live lease and token - state that outlives the thing it describes
            -- and that a late worker could still try to act on.
            evm_claim_lease_until = NULL, evm_claim_token = NULL
      WHERE id = $1 AND status = 'pending'${fence.clause}
      RETURNING *`,
      [id, source, ...fence.params],
  );
  if (row) return { applied: true, row: resolveFastLane(mapRow(row)) };
  return terminalMiss(conn, id, "confirmActivityEventStatusOnly", context);
}

/**
 * The repo-level half of migration 053's per-role confirmed-leg contract - the
 * companion change that file's header names as REQUIRED, not optional: the
 * `agent_activity_yield_confirmed_legs` CHECK proves legs are PRESENT, this
 * proves the CALLER supplied them (and, for `yield_claim`, that it supplied no
 * input leg it could not have spent). The guard mirrors the CHECK arm for arm,
 * deliberately: a divergence between the two is how a row starts satisfying one
 * and violating the other.
 *
 * The row's OWN `event_role` and second-leg tokens are read from the persisted
 * row, never taken from the caller - same posture as the `'swap'` guard above.
 */
function assertYieldConfirmLegs(
  current: AgentActivityEvent,
  input: ConfirmActivityEventInput,
): void {
  const role = current.eventRole;
  const fail = (detail: string): never => {
    throw new Error(`agent_activity: confirmActivityEvent - event_role '${role}' ${detail}`);
  };

  if (role === "yield_claim") {
    // A claim sweeps accrued income: nothing is spent, so an executed INPUT is
    // not merely unnecessary, it is evidence the caller decoded the wrong thing.
    if (!input.executedAmountOutRaw) fail("requires executedAmountOutRaw (the credited income)");
    if (input.executedAmountInRaw) fail("must not carry an executed input leg - a claim spends nothing");
    return;
  }
  // `yield_sy` joins the one-in-one-out arm: an SY wrap/unwrap moves exactly one
  // instrument on each side, so it never reaches the Option-C dual checks below.
  if (role === "yield_pt" || role === "yield_yt" || role === "yield_sy") {
    if (!input.executedAmountInRaw || !input.executedAmountOutRaw) {
      fail("requires executedAmountInRaw + executedAmountOutRaw");
    }
    return;
  }
  if (role === "yield_py" || role === "yield_lp") {
    if (!input.executedAmountInRaw || !input.executedAmountOutRaw) {
      fail("requires executedAmountInRaw + executedAmountOutRaw");
    }
    // Dual invariants apply ONLY where the row populated the dual columns.
    if (current.tokenIn2Address && !input.executedAmountIn2Raw) {
      fail("populated a second INPUT leg, so confirming it requires executedAmountIn2Raw");
    }
    if (current.tokenOut2Address && !input.executedAmountOut2Raw) {
      fail("populated a second OUTPUT leg, so confirming it requires executedAmountOut2Raw");
    }
  }
}

/**
 * `pending -> definitively_failed`. CAS-guarded; returns `{applied, row}`
 * (FIX-SPINE C7). `failureReason` is sanitized here (redacted, never
 * truncated) regardless of what the caller passed (finding 9/C5).
 */
export async function failActivityEvent(
  id: number,
  input: FailActivityEventInput,
  context: TerminalWriteContext = HANDLER_RETURN,
): Promise<TerminalCasResult> {
  const intentOutcome = linkedIntentOutcomeForFailure(input.failureCode);
  if (intentOutcome === null) return runFailActivityEvent(null, id, input, context);

  const sessionId = await resolveActivitySessionByRowId(id);
  return settleLinkedActivityRows({
    activityId: id,
    sessionId,
    intentOutcome,
    activityTarget: {
      status: "definitively_failed",
      failureCode: input.failureCode,
    },
    activityWrite: (client) => runFailActivityEvent(client, id, input, context),
  });
}

function linkedIntentOutcomeForFailure(
  failureCode: AgentActivityFailureCode,
): LinkedIntentRepairOutcome | null {
  if (failureCode === "mined_revert") return "reverted";
  if (failureCode === "solana_signature_expired") return "superseded_unproven";
  if (failureCode === "broadcast_error") return "crashed_before_broadcast";
  return null;
}

/**
 * `failActivityEvent` on the CALLER's transaction and lock. See
 * `confirmActivityEventWith` and this module's header.
 */
export async function failActivityEventWith(
  client: PoolClient,
  id: number,
  input: FailActivityEventInput,
  context: TerminalWriteContext = HANDLER_RETURN,
): Promise<TerminalCasResult> {
  return runFailActivityEvent(client, id, input, context, false);
}

/**
 * Client-bound failure CAS for proof that staging never happened. The extra
 * hashless predicate is checked by the winning UPDATE, not by an earlier read,
 * so a signer that stages concurrently makes this write miss and keeps the
 * row pending for chain observation.
 */
export async function failHashlessActivityEventWith(
  client: PoolClient,
  id: number,
  input: FailActivityEventInput,
): Promise<TerminalCasResult> {
  return runFailActivityEvent(client, id, input, HANDLER_RETURN, true);
}

async function runFailActivityEvent(
  conn: WriteConnection,
  id: number,
  input: FailActivityEventInput,
  context: TerminalWriteContext,
  requireHashless: boolean = false,
): Promise<TerminalCasResult> {
  assertFailureCode(input.failureCode);
  // Under the session control lock - see `./session-lock.ts`. DB-only.
  const fence = claimFence(context, 4);
  const row = await runTerminalCas(
    conn,
    () => resolveActivitySessionByRowId(id),
      `UPDATE agent_activity
        SET status = 'definitively_failed', failure_code = $2, failure_reason = $3,
            updated_at = NOW(), pending_reason = NULL,
            -- A TERMINAL ROW HOLDS NO CLAIM. Cleared in the WINNING update
            -- itself, never in a follow-up statement: the resolver deliberately
            -- skips releaseEvmClaim after a terminal outcome, so a second
            -- statement that got interrupted would leave the row terminal WITH a
            -- live lease and token - state that outlives the thing it describes
            -- and that a late worker could still try to act on.
            evm_claim_lease_until = NULL, evm_claim_token = NULL
      WHERE id = $1 AND status = 'pending'
        ${requireHashless ? "AND tx_hash IS NULL" : ""}${fence.clause}
      RETURNING *`,
      [id, input.failureCode, sanitizeFailureReason(input.failureReason), ...fence.params],
  );
  if (row) return { applied: true, row: resolveFastLane(mapRow(row)) };
  return terminalMiss(conn, id, "failActivityEvent", context);
}
