/**
 * WHAT AN OBSERVATION MEANS for one staged Solana row, and the terminal writes
 * that follow from it - the sweep's entire per-row policy.
 *
 * MOVE-ONLY extraction out of `../solana-activity-repair.ts`, which re-exports
 * `resolveSolanaPendingRows`; the facade keeps the tick-level orchestration
 * (candidate selection and the hashless-intent recovery) and this file keeps
 * terminality. The rules themselves are unchanged, and are documented on the
 * facade because that is the file a reader opens first.
 *
 * ABSENT IS NOT NULL, PROCESSED IS NOT LANDED, EVERY DEAD-END TOUCHES
 * `last_checked_at`, and the expiry gate is the ONE path that may terminalize on
 * absence of proof - each rule is stated where it is applied below.
 */

import {
  confirmActivityEvent,
  confirmActivityEventStatusOnly,
  failActivityEvent,
  touchLastChecked,
  clearVerificationStall,
  noteSettledBlockTime,
  noteSettlementDeclined,
  type AgentActivityEvent,
  type TerminalCasResult,
} from "@vex-agent/db/repos/agent-activity.js";
import { summarizeSolanaOnChainError } from "@tools/solana-ecosystem/shared/solana-transaction/onchain-error-summary.js";
import logger from "@utils/logger.js";

import {
  createSolanaAmountFetchBudget,
  resolveSolanaExecutedAmounts,
  type SolanaAmountFetchBudget,
} from "./amount-decode-lane.js";
import type { SolanaExecutedLegAmounts } from "./executed-amounts.js";
import { isSolanaSweepEscalated } from "./candidate-schedule.js";
import { settleLinkedIntentForRow } from "../wallet-transaction-intent-settlement.js";
import type {
  SolanaActivitySweepDeps,
  SolanaBatchResolution,
  SolanaRpcLookup,
  SolanaSignatureStatusValue,
} from "./sweep-port.js";

/**
 * Resolve a BATCH of staged Solana rows - the sweep's entire per-row policy,
 * extracted so the Wave P fast lane asks the chain exactly the same question,
 * through exactly the same deps, and terminalizes under exactly the same rules.
 *
 * Batching is preserved across both callers, and is why this takes a list rather
 * than a row: `getSignatureStatuses` accepts an array, so one cycle costs ONE
 * RPC round trip however many lanes are due. A per-row fast lane that called
 * this once per row would multiply Solana RPC load by the lane count - exactly
 * the load risk the fast-lane design bounds everywhere else.
 *
 * The caller selects which rows are due; this function owns what an observation
 * means. Every row it cannot resolve still gets `touchLastChecked`, so the
 * global sweep's fairness ordering stays honest even when the fast lane is the
 * one doing the looking.
 */
export async function resolveSolanaPendingRows(
  due: readonly AgentActivityEvent[],
  deps: SolanaActivitySweepDeps,
  nowMs: number,
): Promise<SolanaBatchResolution> {
  if (due.length === 0) return { confirmed: 0, failed: 0, stillPending: 0 };

  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  const statuses = await deps.getSignatureStatuses(due.map((event) => event.txHash!));
  // One budget per resolve call, so the amount lane's extra body fetches are
  // bounded however many rows are due - see its own module for why the bound
  // sits below the batch limit.
  const amountBudget = createSolanaAmountFetchBudget();

  for (const [index, event] of due.entries()) {
    if (isSolanaSweepEscalated(event, nowMs)) {
      logger.warn("solana_activity_repair.long_pending_escalation", {
        id: event.id,
        protocol: event.protocol,
        eventRole: event.eventRole,
        hint: "still pending past the escalation threshold - tracked automatically, never auto-failed on absence of proof",
      });
    }
    const outcome = await processSolanaCandidate(event, statusFor(statuses, index), deps, amountBudget);
    // THE LINKED INTENT (migration 087, T5/T6). This lane owns Solana signature
    // observation, so it settles the `wallet_transaction_intents` row hanging
    // off this activity row instead of a second observer asking the chain the
    // same question. No chain access and no re-send happen in there.
    //
    // The verdict must PRESERVE the distinction the row resolution proved: a
    // `mined_revert` (real on-chain error evidence) is `reverted`, but a
    // blockhash/height EXPIRY with no landed-or-reverted evidence is
    // `superseded_unproven` (T6), never `chain_reverted`. Folding expiry into
    // `reverted` would tell the user the transaction failed on chain when
    // nobody established that it ran at all.
    if (outcome === "confirmed" || outcome === "failed" || outcome === "superseded") {
      const verdict =
        outcome === "confirmed"
          ? "confirmed"
          : outcome === "failed"
            ? "reverted"
            : "superseded_unproven";
      await settleLinkedIntentForRow(event, verdict);
    }
    if (outcome === "confirmed") confirmed++;
    // A superseded row is terminal on the activity side (its blockhash expired),
    // so it counts with the resolved-not-pending rows, never as still pending.
    else if (outcome === "failed" || outcome === "superseded") failed++;
    else if (outcome === "pending") stillPending++;
    // outcome === "duplicate": a concurrent process already settled this row
    // - logged in logDuplicateCas already; never double-counted here.
  }

  return { confirmed, failed, stillPending };
}

/** Project the batched lookup onto ONE row. A short/absent entry is ambiguity, never absence. */
function statusFor(
  batch: SolanaRpcLookup<readonly (SolanaSignatureStatusValue | null)[]>,
  index: number,
): SolanaRpcLookup<SolanaSignatureStatusValue> {
  if (batch.outcome !== "found") return batch;
  const entry = batch.value[index];
  if (entry === undefined) return { outcome: "unavailable" };
  if (entry === null) return { outcome: "not_found" };
  return { outcome: "found", value: entry };
}

type CandidateOutcome = "confirmed" | "failed" | "superseded" | "pending" | "duplicate";

async function processSolanaCandidate(
  event: AgentActivityEvent,
  statusLookup: SolanaRpcLookup<SolanaSignatureStatusValue>,
  deps: SolanaActivitySweepDeps,
  amountBudget: SolanaAmountFetchBudget,
): Promise<CandidateOutcome> {
  if (statusLookup.outcome === "unavailable") {
    logUnavailable(event, "signature_status");
    // Rotate even though nothing was learned. This is the WHOLE-BATCH failure
    // path: the adapter declines the entire `getSignatureStatuses` call when any
    // entry is malformed, so without touching, one bad entry (or an RPC outage)
    // would reselect the same oldest `SOLANA_SWEEP_BATCH_LIMIT` rows every tick
    // forever and starve every newer pending row behind them. No terminal state
    // changes here - fail-closed is untouched.
    await touchLastChecked(event.id, "signature_status_unavailable");
    return "pending";
  }

  if (statusLookup.outcome === "found") {
    if (!isLandedStatus(statusLookup.value.confirmationStatus)) {
      // `processed` only (or an unknown commitment): NOT proven either way -
      // the fork carrying it can still be dropped, taking its error with it.
      // The RPC ANSWERED, so this is not a stall - clear the counter, or an
      // ordinary slow transaction would eventually render "verification
      // stalled", which is a lie about what we know.
      await clearVerificationStall(event.id);
      return "pending";
    }
    if (!hasOwnErr(statusLookup.value)) {
      // Landed commitment but no readable `err` field - the adapter already
      // declines this shape; this is the sweep's own belt-and-suspenders, so a
      // hand-built or future port can never confirm on absent evidence.
      logger.warn("solana_activity_repair.unreadable_signature_status", { id: event.id });
      await touchLastChecked(event.id, "unreadable_signature_status");
      return "pending";
    }
    if (isOnChainError(statusLookup.value.err)) {
      return finalizeMinedFailure(
        event,
        `getSignatureStatuses reported an on-chain error: ${summarizeSolanaOnChainError(statusLookup.value.err)}`,
      );
    }
    // Landed, no error: terminality is settled. What the transaction MOVED is a
    // separate question, and only a row the amount lane deems eligible costs a
    // transaction body to answer it.
    return finalizeLandedConfirm(event, deps, amountBudget);
  }

  // statusLookup.outcome === "not_found" - the status cache only retains recent
  // signatures, so cross-check `getTransaction` before ANY expiry reasoning
  // (BOTH must miss). Its result decides terminality on `meta.err` PRESENCE
  // alone; the SAME body is then handed to the amount lane, which spends no
  // extra RPC call on a transaction already fetched.
  const txLookup = await deps.getFinalizedTransaction(event.txHash!);
  if (txLookup.outcome === "unavailable") {
    logUnavailable(event, "get_transaction");
    // Touch even though nothing was learned: the candidate query orders by
    // `last_checked_at` under a LIMIT, so a row whose fallback keeps failing
    // must move to the BACK of the queue or it pins the window and starves
    // every newer pending row behind it.
    await touchLastChecked(event.id, "get_transaction_unavailable");
    return "pending";
  }
  if (txLookup.outcome === "found") {
    const meta = readTransactionMetaErr(txLookup.value);
    if (!meta.present) {
      logger.warn("solana_activity_repair.unreadable_transaction_meta", { id: event.id });
      await touchLastChecked(event.id, "unreadable_transaction_meta");
      return "pending";
    }
    if (isOnChainError(meta.err)) {
      return finalizeMinedFailure(
        event,
        `getTransaction reported meta.err: ${summarizeSolanaOnChainError(meta.err)}`,
      );
    }
    return finalizeLandedConfirm(event, deps, amountBudget, txLookup.value);
  }

  // BOTH missed - the only path that may terminalize on absence-of-proof,
  // and only when the blockhash is PROVABLY expired.
  return finalizeIfExpired(event, deps);
}

/**
 * `meta.err` out of a raw `getTransaction` result - the only thing this file
 * reads out of a transaction body (the amount lane owns the rest).
 *
 * ABSENT IS NOT NULL. The result is `{ present: false }` unless the body
 * actually CARRIES an `err` property; a missing `meta`, a non-object `meta`, or
 * a `meta` without its own `err` key is malformed evidence, and reading it as
 * `err === null` would status-confirm a transaction whose outcome we never
 * read. Only an explicit `err: null` proves success.
 */
function readTransactionMetaErr(raw: unknown): { present: false } | { present: true; err: unknown } {
  if (typeof raw !== "object" || raw === null) return { present: false };
  const meta = (raw as Record<string, unknown>).meta;
  if (typeof meta !== "object" || meta === null) return { present: false };
  if (!Object.prototype.hasOwnProperty.call(meta, "err")) return { present: false };
  return { present: true, err: (meta as Record<string, unknown>).err };
}

/**
 * Terminalize a row the chain has shown to have landed cleanly, WITH executed
 * amounts when the amount lane could prove them and without any when it could
 * not.
 *
 * The deferral arm (`retry_next_tick`) deliberately does NOT touch
 * `last_checked_at`: nothing was checked, and the confirmation is one-shot, so
 * this row should be first in line again next tick rather than rotating to the
 * back behind rows that were served. It cannot pin the window either - the tick
 * that finally reads its body terminalizes it.
 */
async function finalizeLandedConfirm(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
  amountBudget: SolanaAmountFetchBudget,
  alreadyFetchedBody?: unknown,
): Promise<CandidateOutcome> {
  const lane = await resolveSolanaExecutedAmounts(event, deps, amountBudget, alreadyFetchedBody);
  if (lane.outcome === "retry_next_tick") {
    logger.info("solana_activity_repair.amount_decode_deferred", { id: event.id, reason: lane.reason });
    return "pending";
  }
  if (lane.outcome === "status_only") return finalizeStatusOnlyConfirm(event);
  if (lane.outcome === "undecodable") return finalizeStatusOnlyConfirm(event, lane.reason);

  const outcome = await confirmWithAmounts(event, lane.amounts);
  // The legs were established and the role's guard refused them: no later decode
  // will do better, so this row is undecodable in the same, final sense.
  if (outcome === null) return finalizeStatusOnlyConfirm(event, "role_guard_rejected_legs");
  if (outcome.applied) {
    // The same body that proved the amounts carries the settling block's time;
    // recording it lets the AgentScan report state the chain's own confirmation
    // time. Caught, never thrown: this is a precision write, and a transient DB
    // failure on it must not turn a successful terminalization into a failed
    // sweep invocation.
    if (lane.blockTimeIso !== null) {
      try {
        await noteSettledBlockTime(event.id, lane.blockTimeIso);
      } catch (error) {
        logger.warn("solana_activity_repair.block_time_write_failed", {
          id: event.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return "confirmed";
  }
  logDuplicateCas(event.id, "confirm");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

/**
 * `confirmActivityEvent` with the decoded legs, or `null` when the repo's
 * per-role leg guard refuses them.
 *
 * That guard is the AUTHORITY on which legs a role may be confirmed with, and it
 * throws rather than returning: a lend or prediction role that requires a leg
 * this transaction did not prove must fall back to the status-only confirm, not
 * abort the sweep tick and not have its contract loosened from here.
 */
async function confirmWithAmounts(
  event: AgentActivityEvent,
  amounts: SolanaExecutedLegAmounts,
): Promise<TerminalCasResult | null> {
  try {
    return await confirmActivityEvent(event.id, amounts);
  } catch (error) {
    logger.warn("solana_activity_repair.amount_confirm_rejected", {
      id: event.id,
      eventRole: event.eventRole,
      error: error instanceof Error ? error.message : "unknown",
    });
    return null;
  }
}

/**
 * `undecodableReason` is present ONLY when a transaction body was read and the
 * decoder refused it. It stamps `settlement_source='amounts_undecodable'` AFTER
 * the confirm - the order matters, because `noteSettlementDeclined` only writes
 * on a `confirmed` row - so the outbox releases the row down its declined path
 * instead of holding it for amounts that are never coming.
 *
 * A deferral (RPC unavailable, fetch budget spent) never reaches here: nothing
 * was read, so there is nothing to conclude.
 */
async function finalizeStatusOnlyConfirm(
  event: AgentActivityEvent,
  undecodableReason?: string,
): Promise<CandidateOutcome> {
  // A SIGNATURE STATUS, never a receipt - Solana has none. The provenance code
  // says so, so a later reader cannot mistake this for a decoded receipt.
  const outcome = await confirmActivityEventStatusOnly(event.id, "receipt_status_only_solana");
  if (outcome.applied) {
    if (undecodableReason !== undefined) await stampAmountsUndecodable(event, undecodableReason);
    return "confirmed";
  }
  logDuplicateCas(event.id, "confirm");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

/**
 * Record that this row's amounts were read for and refused. Caught, never
 * thrown: the terminal write already succeeded, and a provenance stamp failing
 * must not turn a settled row into a failed sweep invocation - the row simply
 * waits out the outbox grace instead, which is the pre-stamp behavior.
 */
async function stampAmountsUndecodable(event: AgentActivityEvent, reason: string): Promise<void> {
  try {
    const stamped = await noteSettlementDeclined(event.id, "amounts_undecodable");
    logger.info("solana_activity_repair.settlement_declined", {
      id: event.id,
      reason,
      applied: stamped.applied,
      miss: stamped.reason,
    });
  } catch (error) {
    logger.warn("solana_activity_repair.settlement_decline_write_failed", {
      id: event.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function finalizeIfExpired(
  event: AgentActivityEvent,
  deps: SolanaActivitySweepDeps,
): Promise<CandidateOutcome> {
  if (event.lastValidBlockHeight === null) {
    // No persisted evidence to reason about expiry from (a grandfathered
    // pre-049 row) - never guess; stays pending, like any other ambiguous row.
    await touchLastChecked(event.id, "no_blockhash_evidence");
    return "pending";
  }
  const heightLookup = await deps.getCurrentBlockHeight();
  if (heightLookup.outcome !== "found") {
    logUnavailable(event, "block_height");
    // Same fairness reason as the `getTransaction` outage above: a row that
    // cannot be resolved must still rotate out of the LIMIT window.
    await touchLastChecked(event.id, "block_height_unavailable");
    return "pending";
  }
  if (heightLookup.value <= event.lastValidBlockHeight) {
    // Both lookups answered and the blockhash is provably still valid - we know
    // exactly where this row stands, so this is not a stall.
    await clearVerificationStall(event.id);
    return "pending"; // not yet expired - the tx may still land.
  }
  const outcome = await failActivityEvent(event.id, {
    failureCode: "solana_signature_expired",
    failureReason:
      `Solana activity sweep: blockhash expired (current block height ${heightLookup.value} `
      + `> persisted last_valid_block_height ${event.lastValidBlockHeight}) with no signature found.`,
  });
  // `superseded`, NOT `failed`: an expired blockhash with no signature ever
  // observed is absence of proof, not evidence of an on-chain revert. The
  // linked intent settles `superseded_unproven` (T6); a `failed` verdict here
  // would map to `chain_reverted` and claim the transaction ran and reverted.
  if (outcome.applied) return "superseded";
  logDuplicateCas(event.id, "fail");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

async function finalizeMinedFailure(event: AgentActivityEvent, reason: string): Promise<CandidateOutcome> {
  const outcome = await failActivityEvent(event.id, {
    failureCode: "mined_revert",
    failureReason: `Solana activity sweep: ${reason}.`,
  });
  if (outcome.applied) return "failed";
  logDuplicateCas(event.id, "fail");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

function isOnChainError(err: unknown): boolean {
  return err !== null && err !== undefined;
}

/** ABSENT IS NOT NULL - only an entry that CARRIES an `err` field is evidence either way. */
function hasOwnErr(value: SolanaSignatureStatusValue): boolean {
  return Object.prototype.hasOwnProperty.call(value, "err");
}

function isLandedStatus(status: string | null): boolean {
  return status === "confirmed" || status === "finalized";
}

function logUnavailable(
  event: AgentActivityEvent,
  stage: "signature_status" | "get_transaction" | "block_height",
): void {
  logger.warn("solana_activity_repair.rpc_unavailable", { id: event.id, stage });
}

function logDuplicateCas(id: number, attempted: "confirm" | "fail"): void {
  // Not a failure - a concurrent process (another sweep run, or a handler's
  // own late finalize) already settled this row before this sweep got to it.
  logger.info("solana_activity_repair.duplicate_cas_miss", { id, attempted });
}
