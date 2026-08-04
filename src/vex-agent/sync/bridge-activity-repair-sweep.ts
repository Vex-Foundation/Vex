/**
 * `bridge-activity-repair.ts` pure sweep orchestration — split out (Card C5,
 * move-only) once the parent file crossed the repo's 500-line cap. See
 * `bridge-activity-repair.ts`'s own module doc for the full W4 design (R12/
 * B4/B6/C3, dossier §2) this orchestration implements — fair scheduling
 * (`./bridge-activity-repair-fairness.js`), per-row status observation,
 * dispatch of terminal outcomes to
 * `./bridge-activity-repair-terminalize.js` (the B4-verified confirm, the
 * verify-then-write-then-terminalize refund path, provider failures), and R5
 * null-order-id recovery. Pure over the injected `BridgeRepairDeps` port —
 * no IO of its own.
 */

import type { BridgeChainFamily } from "@vex-agent/db/repos/agent-activity.js";
import { clearRelayRouteReveal } from "@vex-agent/tools/registry/relay-reveal.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import {
  BRIDGE_SWEEP_BATCH_LIMIT,
  type BridgeObservation,
  type BridgeRepairDeps,
  type BridgeRepairSweepResult,
  type BridgeSweepRow,
  type MutableSweepCounters,
  type StoredBridgeCorrelation,
  type StoredBridgeRoute,
} from "./bridge-activity-repair-contracts.js";
import { mapKhalaniOrderOutcome, mapRelayStatusOutcome } from "./bridge-activity-repair-status-map.js";
import { compareBridgeFairness } from "./bridge-activity-repair-fairness.js";
import {
  confirmVerifiedFill,
  recoverDebridgeFillHash,
  terminalizeProviderFailure,
  terminalizeRefund,
} from "./bridge-activity-repair-terminalize.js";
import { logInconclusiveVerification } from "./bridge-activity-repair-log.js";

/** Provider-native Solana chain ids (Khalani vs Relay diverge) — used only to infer a row's chain family for explorer-link resolution. */
const SOLANA_CHAIN_IDS: ReadonlySet<number> = new Set([20011000000, 792703809]);

// ── Orchestration (pure over the injected deps) ─────────────────────────────

export async function repairPendingBridges(deps: BridgeRepairDeps): Promise<BridgeRepairSweepResult> {
  const counters: MutableSweepCounters = {
    confirmed: 0,
    failed: 0,
    refunded: 0,
    recovered: 0,
    balanceReconciled: 0,
    stillPending: 0,
  };

  const candidates = (await deps.listSweepCandidates(BRIDGE_SWEEP_BATCH_LIMIT)).slice().sort(compareBridgeFairness);
  for (const logical of candidates) {
    await sweepLogicalRow(logical, deps, counters);
  }

  await recoverMissingOrderIds(deps, counters);
  await reconcileBalanceEnqueues(deps, counters);

  return {
    checked: candidates.length,
    confirmed: counters.confirmed,
    failed: counters.failed,
    refunded: counters.refunded,
    recovered: counters.recovered,
    balanceReconciled: counters.balanceReconciled,
    stillPending: counters.stillPending,
  };
}

async function sweepLogicalRow(
  logical: BridgeSweepRow,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;
  const orderId = logical.providerOrderId;
  if (!orderId) {
    // Defensive: the sweep query filters to non-null order ids; a null here means
    // a racing recovery — leave it for the recovery queue.
    counters.stillPending++;
    return;
  }

  // B6: every attempt advances the fair-scheduling clock, BEFORE the provider call,
  // so a persistently-failing row yields its slot even when the fetch throws.
  await deps.touchAttempt(executionId);

  const correlation = readStoredCorrelation(logical);
  if (!correlation) {
    logInconclusiveVerification({ event: "bridge.repair.logical_missing_route", logical, reason: "missing_route" });
    await deps.noteVerificationInconclusive(logical.id, "missing_route");
    counters.stillPending++;
    return;
  }

  const observation = await observeProvider(logical, orderId, correlation, deps);
  if (!observation) {
    // Transport failure — attempt already recorded, no observation, stays pending.
    // Migration 065: this is exactly the shape that used to die in a debug log.
    await deps.noteVerificationInconclusive(logical.id, "provider_unreachable");
    counters.stillPending++;
    return;
  }

  // B6: a SUCCESSFUL provider observation advances `last_checked_at` + records the
  // last provider status for the feed (even when non-terminal).
  await deps.touchChecked(executionId, observation.providerStatus);
  await applyObservation(logical, observation, deps, counters);
}

/** Fetch + map the provider status for the logical row. `null` on transport failure only. */
async function observeProvider(
  logical: BridgeSweepRow,
  orderId: string,
  correlation: StoredBridgeCorrelation,
  deps: BridgeRepairDeps,
): Promise<BridgeObservation | null> {
  if (logical.protocol === "khalani") {
    const order = await deps.fetchKhalaniOrder(orderId);
    return order ? mapKhalaniOrderOutcome(order, correlation) : null;
  }
  if (logical.protocol === "relay") {
    const status = await deps.fetchRelayStatus(orderId);
    return status ? mapRelayStatusOutcome(status, correlation) : null;
  }
  logger.warn("bridge.repair.unknown_protocol", {
    executionId: logical.protocolExecutionId,
    protocol: logical.protocol,
  });
  return null;
}

async function applyObservation(
  logical: BridgeSweepRow,
  observation: BridgeObservation,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  switch (observation.kind) {
    case "pending":
      // CONCLUSIVE: the provider answered and the row is legitimately still in
      // flight. Reset the stall counter — a healthy slow bridge must never
      // accumulate its way into "verification stalled".
      await deps.noteVerificationConclusive(logical.id);
      counters.stillPending++;
      return;

    case "filled_no_hash":
      // dossier §5: provider claims filled/success but produced no fill hash. For a
      // DeBridge-routed Khalani order the hash is recoverable from deBridge's own
      // stats API (F2) — everything else stays pending + anomaly, and a recovered
      // hash still passes the unchanged B4 verification before any confirm.
      await recoverDebridgeFillHash(logical, observation, deps, counters);
      return;

    case "chain_mismatch":
      logInconclusiveVerification({
        event: "bridge.repair.chain_id_mismatch",
        logical,
        reason: "chain_mismatch",
        context: { providerStatus: observation.providerStatus },
      });
      await deps.noteVerificationInconclusive(logical.id, "chain_mismatch");
      counters.stillPending++;
      return;

    case "correlation_mismatch":
      // R6 anomaly (Blocker 7): a carried-and-stored identity field disagrees. Log
      // the field NAME only (never raw provider values) and stay pending — we do
      // NOT terminalize a mismatched order onto our row.
      logInconclusiveVerification({
        event: "bridge.repair.correlation_mismatch",
        logical,
        reason: "correlation_mismatch",
        context: { providerStatus: observation.providerStatus, field: observation.field },
      });
      await deps.noteVerificationInconclusive(logical.id, "correlation_mismatch");
      counters.stillPending++;
      return;

    case "confirmable":
      await confirmVerifiedFill(logical, observation, deps, counters);
      return;

    case "refunded":
      await terminalizeRefund(logical, observation, deps, counters);
      return;

    case "failed":
      await terminalizeProviderFailure(logical, observation, deps, counters);
      return;
  }
}

/**
 * R5 order-id recovery — the ONLY verifier a crash-after-deposit row has.
 *
 * Such a row carries no `provider_order_id`, so the ordinary sweep's candidate
 * query cannot see it at all. That makes recording the stall REASON on every
 * unsuccessful exit load-bearing rather than cosmetic: without it the row is
 * retried forever while the UI renders an ordinary healthy pending, and the
 * user is never told that Vex has repeatedly been unable to check. It stays
 * pending either way — a stall is "we could not look", never an auto-fail.
 *
 * The counter is CLEARED on a successful attach: the row now has an order id,
 * the ordinary sweep owns it, and carrying a stall in from the recovery queue
 * would render a now-verifiable row as stalled.
 */
async function recoverMissingOrderIds(deps: BridgeRepairDeps, counters: MutableSweepCounters): Promise<void> {
  const candidates = await deps.listOrderIdRecoveryCandidates(BRIDGE_SWEEP_BATCH_LIMIT);
  for (const candidate of candidates) {
    await deps.touchAttempt(candidate.executionId); // B6: recovery queue shares the fair-scheduling discipline.
    let orderId: string | null;
    try {
      orderId = await deps.recoverKhalaniOrderId(candidate);
    } catch (err) {
      logger.warn("bridge.repair.order_recovery_failed", {
        executionId: candidate.executionId,
        error: summarizeProtocolError(err).message,
      });
      await deps.noteVerificationInconclusive(candidate.logicalRowId, "recovery_throw");
      counters.stillPending++;
      continue;
    }
    if (!orderId) {
      await deps.noteVerificationInconclusive(candidate.logicalRowId, "recovery_null");
      counters.stillPending++;
      continue;
    }
    const attach = await deps.attachOrderId({ executionId: candidate.executionId, providerOrderId: orderId });
    await deps.touchChecked(candidate.executionId, `order_recovered:${attach.outcome}`);
    if (attach.outcome === "attached" || attach.outcome === "already_attached_same") {
      await deps.noteVerificationConclusive(candidate.logicalRowId);
      counters.recovered++;
    } else {
      // conflict_different_id / not_pending — the repo already logged the anomaly.
      await deps.noteVerificationInconclusive(candidate.logicalRowId, "attach_conflict");
      counters.stillPending++;
    }
  }
}

/**
 * C3 recovery path (Blocker 11): idempotently enqueue the balance-refresh job for
 * confirmed logical bridge rows whose execution still has none — closing the
 * confirmed-but-unenqueued crash window between the confirm CAS and the enqueue.
 * It ALSO clears any stranded relay reveal for those rows (the confirm path might
 * have crashed after the CAS but before/at the reveal-clear). The list query
 * returns ONLY rows still needing it (bounded fair queue, no age cutoff), so this
 * self-limits; the enqueue is idempotent regardless.
 */
async function reconcileBalanceEnqueues(deps: BridgeRepairDeps, counters: MutableSweepCounters): Promise<void> {
  const rows = await deps.listConfirmedNeedingBalanceRefresh(BRIDGE_SWEEP_BATCH_LIMIT);
  for (const row of rows) {
    if (row.protocol === "relay" && row.sessionId && row.normalizedRoute) {
      deps.clearRelayReveal(row.sessionId, row.normalizedRoute);
    }
    try {
      await deps.enqueueBalanceRefresh({ namespace: row.protocol, executionId: row.executionId });
      counters.balanceReconciled++;
    } catch (err) {
      // One row's enqueue failure must not abort the rest — it stays in the
      // needing-refresh set and is retried next sweep.
      logger.warn("bridge.repair.reconcile_enqueue_failed", {
        executionId: row.executionId,
        error: summarizeProtocolError(err).message,
      });
    }
  }
}

/** Infer a chain's family from its provider-native id (only the known Solana ids are non-eip155). */
function inferBridgeChainFamily(chainId: number): BridgeChainFamily {
  return SOLANA_CHAIN_IDS.has(chainId) ? "solana" : "eip155";
}

function readStoredCorrelation(logical: BridgeSweepRow): StoredBridgeCorrelation | null {
  if (logical.fromChainId === null || logical.toChainId === null) return null;
  // The logical row stores the DESTINATION family authoritatively (the fill leg
  // executes on the destination). The origin family is inferred from its id (only
  // the Solana ids are non-eip155) — used for the refund evidence row's explorer
  // link family and for family-aware identity comparison, never for a fund-critical
  // decision on its own.
  const route: StoredBridgeRoute = {
    fromChainId: logical.fromChainId,
    fromChainFamily: inferBridgeChainFamily(logical.fromChainId),
    toChainId: logical.toChainId,
    toChainFamily: logical.destChainFamily,
  };
  return {
    route,
    providerOrderId: logical.providerOrderId,
    tokenInAddress: logical.tokenInAddress,
    tokenOutAddress: logical.tokenOutAddress,
    author: logical.walletAddress,
    depositTxHash: logical.depositTxHash,
    quoteId: logical.quoteId,
    routeId: logical.routeId,
  };
}
