/**
 * `agent_activity` EVM repair sweep — a STATUS-ONLY pending-transaction
 * resolver (owner decree 2026-07-30).
 *
 * ONE QUESTION PER ROW: take the pending row's tx hash, resolve a read-only RPC
 * for the chain the transaction was made on, and ask the chain whether it
 * succeeded or reverted. Success → `confirmed`. Mined revert →
 * `definitively_failed`. Nothing else. The sweep is PROTOCOL-AGNOSTIC: it holds
 * no venue knowledge, decodes nothing, and reads no amounts.
 *
 * WHY THE DECODERS WENT AWAY. This sweep used to confirm only when a registered
 * per-protocol settlement decoder could turn the receipt into executed amounts.
 * A decoder that declined left the row `pending` FOREVER — which is exactly what
 * happened to a KyberSwap CAT→native-ETH swap on Robinhood Chain (4663) that was
 * mined `success` on-chain: the native-out leg arrives as a wrapped-native burn
 * with no Withdrawal event to the router, so the decoder could not prove it. A
 * lifecycle sweep that cannot report a settled transaction as settled is worse
 * than one that reports the status without the amounts.
 *
 * AMOUNTS ARE DEFERRED, NOT FAKED (owner decree; rule `90-vex-project.md`). A
 * status-only confirm writes NO `executed_*` column — see
 * `confirmActivityEventStatusOnly`. Agent Scan then shows the QUOTED amount
 * explicitly labelled "estimated". Copying the quote into the executed columns
 * would record a quote as a settlement, which is the one thing that seam exists
 * to prevent.
 *
 * LOOKUP-ONLY, by construction: the dependency surface is exactly ONE function,
 * a receipt lookup by hash. This module holds no signer, never imports a
 * send/broadcast/sign capability, and never re-quotes or re-executes.
 *
 * AMBIGUITY NEVER TERMINALIZES (FIX-SPINE C1): a missing receipt (not yet
 * mined), an unreadable receipt status, or a lookup error (transient RPC
 * failure) NEVER finalizes the row — it stays `pending`, re-checked on the next
 * sweep, only `last_checked_at` moves. There is NO time-based escalation to
 * `confirmation_timeout` (that failure_code stays in the closed enum but is
 * reserved — never auto-set here or anywhere).
 *
 * EVERY DEAD END TOUCHES `last_checked_at`: the candidate query orders by it
 * under a LIMIT, so a row that cannot be resolved this tick must rotate to the
 * BACK of the queue. Otherwise a handful of permanently-unresolvable rows pin
 * the window and starve every newer pending row behind them.
 *
 * A MINED REVERT is the sweep's ONE definitive-failure path
 * (`failure_code = 'mined_revert'`, distinct from `simulation_reverted`, which
 * is a PRE-broadcast revert recorded by the handler itself).
 *
 * DUPLICATE-CAS AWARENESS (C7): the finalizers return `{applied, row}` — an
 * `applied:false` here means a concurrent process (another sweep instance, or
 * the handler's own late finalize) already settled this row; the sweep logs it
 * and moves on without double-counting.
 *
 * ERROR LOGGING (FIX5-SPINE): the lookup catch routes its `error` field through
 * `summarizeProtocolError(err).message` (`runtime/errors.ts`'s canonical scrub
 * boundary), never a bare `redact()` call — a provider/RPC error can carry URLs,
 * request/response bodies, and auth headers that `redact()` alone (secret-SHAPE
 * detection only) does not strip.
 */

import {
  claimDuePendingEvm,
  clearNonInclusionClock,
  clearVerificationStall,
  confirmActivityEventStatusOnly,
  failActivityEvent,
  markSupersededUnproven,
  nextEvmCheckInMs,
  noteNonInclusionObserved,
  notePendingReason,
  releaseEvmClaim,
  touchLastChecked,
  type AgentActivityEvent,
  type ClaimDuePendingEvmResult,
} from "@vex-agent/db/repos/agent-activity.js";
import {
  MINED_REVERT_ROLE_NEUTRAL_REASON,
  MINED_REVERT_SWAP_LEG_REASON,
} from "@vex-agent/tools/protocols/runtime/mined-revert-reason.js";
import { emitPendingProgress } from "@vex-agent/events/pending-progress-bus.js";
import logger from "@utils/logger.js";

import type {
  EvmObservation,
  EvmObservationInput,
} from "./agent-activity-repair/observation.js";

// The three chain SOURCES and the production observation dep built on them live
// in the sibling module — wiring, not policy. Re-exported here because every
// caller (the fast lane, the periodic tick, the amount fallback, four test
// suites) imports them from this module's public name.
export {
  buildProductionRepairDeps,
  resolveReadOnlyReceiptClient,
} from "./agent-activity-repair/chain-sources.js";
import { REPAIR_CANDIDATE_AGE_MS, isPastHandlerWindow } from "./handler-window.js";

// The gate's own leaf module owns both, so the lane and the fast lane can share
// them without importing each other. Re-exported here because every existing
// caller — including three integration suites — imports them from this module.
export { REPAIR_CANDIDATE_AGE_MS, isPastHandlerWindow };

/**
 * Bounded batch per sweep run (FIX-SPINE C11 — finding 12): the sweep does
 * serial RPC calls per run inside the shared sync worker — an unbounded backlog
 * would starve balance/Jupiter sync sharing the same drain. Any remainder is
 * picked up on the NEXT periodic tick; `listPendingOlderThan` orders by
 * least-recently-checked so the window rotates instead of re-serving the same
 * rows.
 */
export const REPAIR_BATCH_LIMIT = 25;

/**
 * Simultaneous chain lookups inside one lane pass. Raising this is the first
 * thing that will exhaust the DB pool (`max: 10`), which the balance and bridge
 * sweeps share.
 */
export const EVM_LANE_MAX_CONCURRENCY = 3;

/** Run `task` over `items` with at most `limit` in flight. */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      if (item === undefined) return;
      await task(item);
    }
  });
  await Promise.all(workers);
}

export interface RepairDeps {
  /**
   * The ONLY dependency this sweep may have. Read-only — never a
   * send/broadcast/sign capability.
   *
   * It returns an OBSERVATION rather than a receipt-or-null: "we could not
   * look", "it is in a mempool", "its nonce was consumed by something else" and
   * "no node has heard of it" are four different facts, and collapsing them into
   * one `null` is what left every surface unable to say anything useful about a
   * pending row.
   */
  readonly observeTransaction: (input: EvmObservationInput) => Promise<EvmObservation>;
}

export interface RepairSweepResult {
  readonly checked: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly stillPending: number;
}

/**
 * The 30 s executor tick's entry point — now a THIN CALLER of the same
 * phase-aware claimant the fast lane uses, not a second scheduler.
 *
 * It used to run its own `listPendingOlderThan(90s, …)` query, which is why a
 * fresh row was invisible to it for 90 seconds and why two drivers could observe
 * the same row concurrently. One claimant means one cadence contract, one lease,
 * and one definition of "due".
 *
 * The 90 s money gate did not go away — it moved to where it belongs, gating
 * TERMINALIZATION rather than OBSERVATION (`allowTerminalize` below). Inside the
 * window the lane may look and record what it saw; it may not run a status CAS,
 * because the owning handler may still be decoding its own receipt.
 */
export async function repairPendingActivity(deps: RepairDeps): Promise<RepairSweepResult> {
  // W5 design REVISION 1 R3: this sweep owns ONLY EVM ('eip155') rows — the
  // Solana activity sweep (`solana-activity-repair.ts`) owns every
  // chain_family='solana' staged row via its own disjoint candidate query. The
  // claim's own predicate enforces the family.
  const claim = await claimDuePendingEvm(REPAIR_BATCH_LIMIT);
  reportClaimOverflow(claim);

  const now = Date.now();
  let confirmed = 0;
  let failed = 0;
  let stillPending = 0;

  // BOUNDED, NOT SERIAL. A full 25-row page where every row needs all three
  // calls is ~11 s serially — longer than the 5 s cadence the page exists to
  // deliver, so the lane would fall behind exactly when it is busiest. Bounded
  // at three in flight because the DB pool is `max: 10` and the other sweeps
  // share it.
  await forEachBounded(claim.claimed, EVM_LANE_MAX_CONCURRENCY, async (claimed) => {
    const outcome = await resolveEvmPendingRow(claimed.row, deps, {
      claimToken: claimed.claimToken,
      allowTerminalize: isPastHandlerWindow(claimed.row, now),
    });
    if (outcome === "confirmed") confirmed++;
    else if (outcome === "failed") failed++;
    else if (outcome === "pending" || outcome === "superseded" || outcome === "claim_lost") {
      // A lost claim is still a row that did not settle on OUR watch — counted
      // as pending, never as a failure, and never retried here.
      stillPending++;
    }
    // "duplicate": a concurrent process already settled this row — logged in
    // `logDuplicateCas`; never double-counted here.
  });

  return { checked: claim.claimed.length, confirmed, failed, stillPending };
}

/**
 * The 25-row SLA is the owner's accepted number, so row 26 is not a defect — but
 * a degradation nobody can see is indistinguishable from a bug. When the page
 * came back full AND more rows are due, say so once per cycle, with how long the
 * oldest waiting row has waited.
 *
 * Nothing starves: the claim's fairness order serves the longest-waiting rows
 * first, so the queue rotates and the honest statement is "≤25 concurrent
 * pending rows hold the cadence; beyond that it degrades to fair rotation".
 */
export function reportClaimOverflow(claim: ClaimDuePendingEvmResult): void {
  if (claim.overflowDue <= 0) return;
  logger.warn("sync.evm_claim.overflow", {
    due: claim.overflowDue + claim.claimed.length,
    claimed: claim.claimed.length,
    oldestWaitMs: claim.oldestUnclaimedWaitMs,
  });
}

/** What one candidate's resolution attempt concluded. Mirrors the Solana sweep's own outcome union. */
export type EvmRepairOutcome =
  | "confirmed"
  | "failed"
  | "pending"
  | "duplicate"
  | "superseded"
  /**
   * OUR CLAIM WAS LOST — the lease expired mid-observation and another driver
   * legitimately owns the row now, so the write applied to zero rows. Its own
   * member rather than a flavour of "pending", because it changes what the
   * caller may do next: it must NOT release (we hold nothing) and must NOT
   * retry (retrying is how a stale observation eventually wins).
   */
  | "claim_lost";

/**
 * The claim this resolution is running under, and whether it may terminalize.
 *
 * `allowTerminalize` is the 90 s money gate, expressed as ONE flag that gates
 * the CALL to a CAS — deliberately not a second policy branch inside the
 * observation mapping. The point of this function is that terminality lives in
 * exactly one place; a flag that forked the MEANING of an observation would
 * undo that.
 */
export interface EvmResolutionContext {
  readonly claimToken: string;
  readonly allowTerminalize: boolean;
}

/**
 * Resolve ONE pending EVM row — the sweep's entire per-row policy, extracted so
 * the Wave P fast lane asks the chain exactly the same question, through exactly
 * the same deps, and terminalizes under exactly the same rules.
 *
 * EXTRACTION IS THE POINT: a second implementation of "when may a status-only
 * observation terminalize a row" is precisely the kind of duplicated money logic
 * that drifts. The fast lane owns *when* to call this; this function owns *what
 * it means*.
 *
 * The caller is responsible for the 90 s candidate-age gate
 * (`REPAIR_CANDIDATE_AGE_MS`). The sweep enforces it in its candidate query; the
 * fast lane enforces it explicitly before calling here — see `fast-lane.ts`.
 */
export async function resolveEvmPendingRow(
  event: PendingEvmRow,
  deps: RepairDeps,
  context: EvmResolutionContext,
): Promise<EvmRepairOutcome> {
  if (!event.txHash) {
    // No signed hash was ever persisted (crash before step 2) — nothing to look
    // up. The claim's own predicate excludes such rows, so this is reachable
    // only through a direct caller; it releases and leaves the row alone.
    await releaseEvmClaim(event.id, context.claimToken);
    return "pending";
  }

  const observation = await deps.observeTransaction({
    chainId: event.chainId,
    txHash: event.txHash,
    // The row's OWN persisted sender and nonce. Supersession is NEVER inferred:
    // without both, the observation can only conclude `unknown_to_node`.
    fromAddress: event.fromAddress,
    nonce: event.nonce,
  });

  const outcome = await applyObservation(event, observation, context);

  // THE PUSH, from ONE place: a row that is still pending after an observation
  // is precisely the case the `resolved` bus cannot carry, and without it the
  // 5 s cadence never reaches the screen — the renderer polls at 60 s. A
  // terminalized row is NOT pushed here: its own terminalizing CAS already
  // emitted `resolved`, and two pushes for one transition would make the
  // renderer re-read twice and render the same row from two different signals.
  if (outcome === "pending") {
    emitPendingProgress({
      activityId: event.id,
      chainFamily: "eip155",
      chainId: event.chainId,
      ...progressReasons(observation),
      // The row's CURRENT phase, never a hard-coded 5 s.
      nextCheckInMs: nextEvmCheckInMs(event.submitAttemptedAt, Date.now()),
    });
  }

  // A terminalizing CAS clears the claim itself, so releasing afterwards would
  // either be a no-op or — if the row was re-claimed in between — a release of
  // SOMEONE ELSE's claim that only the token predicate stops. Not asking is
  // simpler than relying on the fence to catch us.
  // A LOST claim is deliberately excluded: we do not hold this row, so the
  // release could only fail — and it would emit a SECOND `sync.evm_claim.lost`
  // for one fact. The writer that observed the zero-row result already said it.
  if (outcome === "pending" || outcome === "duplicate") {
    await releaseEvmClaim(event.id, context.claimToken);
  }
  return outcome;
}

/**
 * The two reason columns, as the push reports them.
 *
 * They are mutually exclusive by construction, because they answer different
 * questions: `pendingReason` is a CONCLUSIVE observation ("we looked and it is
 * in the mempool"), `verificationReason` is a failed CHECK ("we could not
 * conclude"). Setting both would let a surface describe one observation as both
 * a conclusion and a failure.
 */
function progressReasons(observation: EvmObservation): {
  pendingReason: string | null;
  verificationReason: string | null;
} {
  switch (observation.kind) {
    case "in_mempool":
      return { pendingReason: "in_mempool", verificationReason: null };
    case "nonce_superseded":
      return { pendingReason: "nonce_superseded", verificationReason: null };
    case "unknown_to_node":
      return { pendingReason: null, verificationReason: "tx_unknown_to_node" };
    case "unreadable_receipt":
      return { pendingReason: null, verificationReason: "unreadable_receipt_status" };
    case "rpc_error":
      return { pendingReason: null, verificationReason: "rpc_error" };
    case "mined":
      // Reachable only inside the 90 s window, where the lane observed inclusion
      // but may not act on it yet. Neither column applies: nothing failed, and
      // the row is not pending for a reason we could name.
      return { pendingReason: null, verificationReason: null };
  }
}

/**
 * What ONE observation means for the row — the whole of the lane's per-row
 * policy, and the only place it exists.
 *
 * Two axes decide every branch, and they are deliberately independent:
 *
 * - **conclusive vs inconclusive** decides the COUNTER. We looked and learned
 *   something definite (`mined`, `in_mempool`) resets the stall; we could not
 *   conclude (`rpc_error`, `unknown_to_node`, an unreadable status) increments
 *   it. Migration 065's counter measures a STALL, not age, and at 5 s an
 *   unthrottled increment would call a healthy transaction "stalled" in 100
 *   seconds.
 * - **`allowTerminalize`** decides only whether a CAS may be CALLED. It never
 *   forks what an observation MEANS — that is the invariant that keeps
 *   terminality in one place.
 *
 * The A6 clock is a third, orthogonal fact: it measures a CONTINUOUS run of
 * non-inclusion, so every contrary observation clears it, including one we could
 * not read the status of (a receipt exists ⇒ the transaction was included).
 */
async function applyObservation(
  event: PendingEvmRow,
  observation: EvmObservation,
  context: EvmResolutionContext,
): Promise<EvmRepairOutcome> {
  const { claimToken, allowTerminalize } = context;

  switch (observation.kind) {
    case "mined": {
      // Included. Whatever the status says, the row is NOT non-included, so the
      // A6 clock is contradicted and the check concluded.
      await clearNonInclusionClock(event.id, claimToken);
      await clearVerificationStall(event.id, claimToken);
      if (!allowTerminalize) return "pending";
      // THE FENCE APPLIES TO THE MINED PATHS TOO. These are post-RPC writes like
      // every other, and they are the ones where losing the race costs the most:
      // a stale worker's STATUS-ONLY confirm wins the once-only
      // `WHERE status='pending'` transition and locks out the live holder's
      // strict confirm-with-amounts, recreating the `confirmed + estimated +
      // executedAmount* null` row this wave exists to fix. The 90 s gate does
      // not cover it — by the time a lease has expired, that window is long past.
      return observation.status === "reverted"
        ? await failMinedRevert(event, claimToken)
        : await confirmMinedSuccess(event, claimToken);
    }

    case "unreadable_receipt": {
      // A receipt EXISTS — that is inclusion evidence, so the A6 clock clears —
      // but its status is a value we cannot read. NEVER a revert: a
      // `definitively_failed` write is irreversible and this is not proof.
      await clearNonInclusionClock(event.id, claimToken);
      await touchLastChecked(event.id, "unreadable_receipt_status", claimToken);
      return "pending";
    }

    case "in_mempool": {
      // The healthiest pending answer there is: known to the node, not yet
      // mined. Conclusive, so it resets the counter — and it is recorded in
      // `pending_reason` (067), never in `last_verification_reason`, because a
      // successful observation is not a failed check.
      await clearNonInclusionClock(event.id, claimToken);
      await clearVerificationStall(event.id, claimToken);
      await notePendingReason(event.id, "in_mempool", { kind: "claim", claimToken });
      return "pending";
    }

    case "nonce_superseded": {
      // Conclusive: another transaction from this wallet used this nonce and
      // this hash has no receipt. It does NOT establish that nothing was spent
      // or that a retry is safe — see the pending reason's own doc — so the only
      // thing that follows is that we stop tracking it as in flight.
      await clearVerificationStall(event.id, claimToken);
      await noteNonInclusionObserved(event.id, claimToken);
      await notePendingReason(event.id, "nonce_superseded", { kind: "claim", claimToken });
      return await terminalizeIfWindowOpen(event, "nonce_superseded", context);
    }

    case "unknown_to_node": {
      // INCONCLUSIVE, and the distinction matters: the transaction may be
      // sitting in a mempool we did not ask. That is exactly why A6 needs a
      // bounded continuous-run window before it may terminalize.
      await noteNonInclusionObserved(event.id, claimToken);
      await touchLastChecked(event.id, "tx_unknown_to_node", claimToken);
      return await terminalizeIfWindowOpen(event, "tx_unknown_to_node", context);
    }

    case "rpc_error": {
      // "We could not look", as distinct from "we looked and there is nothing".
      // It says nothing about inclusion, so the A6 clock is left exactly where
      // it is — neither started nor cleared.
      logger.debug("agent_activity.repair.lookup_failed", {
        id: event.id,
        chainId: event.chainId,
        error: observation.reason,
      });
      await touchLastChecked(event.id, "rpc_error", claimToken);
      return "pending";
    }
  }
}

/**
 * Attempt the A6 transition, and treat every refusal as "still pending".
 *
 * The CAS carries all five guards itself — status, claim token, hash present,
 * the 90 s money gate and the continuous non-inclusion window — so a refusal
 * here is the ordinary case for most of a row's life, not an error. It is never
 * escalated to a failure and never retried in a loop: the next claim asks again.
 */
async function terminalizeIfWindowOpen(
  event: PendingEvmRow,
  reason: "nonce_superseded" | "tx_unknown_to_node",
  context: EvmResolutionContext,
): Promise<EvmRepairOutcome> {
  if (!context.allowTerminalize) return "pending";
  const result = await markSupersededUnproven(
    event.id,
    { claimToken: context.claimToken, reason },
    REPAIR_CANDIDATE_AGE_MS,
  );
  // A LOST CLAIM IS NOT A REFUSAL. The A6 CAS is fenced like every other
  // post-RPC write, so a stale worker's attempt wrote zero rows because it no
  // longer owns the row — reporting that as `pending` would send it back through
  // a release it cannot win and a second `sync.evm_claim.lost`, which is exactly
  // what the dedicated outcome exists to prevent. Every OTHER miss (the window
  // not yet elapsed, someone else already terminal) IS a genuine "still ours,
  // still in flight" and keeps its release.
  if (result.reason === "claim_lost") return "claim_lost";
  if (!result.applied) return "pending";
  logger.info("agent_activity.repair.superseded_unproven", { id: event.id, reason });
  return "superseded";
}

async function failMinedRevert(
  event: PendingEvmRow,
  claimToken: string,
): Promise<EvmRepairOutcome> {
  const outcome = await failActivityEvent(event.id, {
    failureCode: "mined_revert",
    // A `swap` row gets the swap remedy — the same event deserves the same
    // explanation however Vex noticed it. Every other role stays NEUTRAL: this
    // sweep holds only a row (it sees approvals, bridge deposits and fee
    // transfers alike) and has no venue knowledge to spend, so it states only
    // what is certainly true.
    failureReason: event.eventRole === "swap"
      ? MINED_REVERT_SWAP_LEG_REASON
      : MINED_REVERT_ROLE_NEUTRAL_REASON,
  }, { kind: "claim", claimToken });
  if (outcome.applied) return "failed";
  if (outcome.reason === "claim_lost") return "claim_lost";
  logDuplicateCas(event.id, "fail");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}

async function confirmMinedSuccess(
  event: PendingEvmRow,
  claimToken: string,
): Promise<EvmRepairOutcome> {
  const outcome = await confirmActivityEventStatusOnly(
    event.id,
    "receipt_status_only_evm",
    { kind: "claim", claimToken },
  );
  if (outcome.applied) return "confirmed";
  if (outcome.reason === "claim_lost") return "claim_lost";
  logDuplicateCas(event.id, "confirm");
  return outcome.row.status === "pending" ? "pending" : "duplicate";
}


/** The fields `resolveEvmPendingRow` actually reads — narrower than the full row on purpose. */
export type PendingEvmRow = Pick<
  AgentActivityEvent,
  "id" | "chainId" | "txHash" | "eventRole" | "fromAddress" | "nonce" | "submitAttemptedAt"
>;

function logDuplicateCas(id: number, attempted: "confirm" | "fail"): void {
  // Not a failure — a concurrent process (another sweep run, or the handler's
  // own late finalize) already settled this row before this sweep got to it.
  logger.info("agent_activity.repair.duplicate_cas_miss", { id, attempted });
}
