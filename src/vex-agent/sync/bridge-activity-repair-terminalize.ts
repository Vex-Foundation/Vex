/**
 * `bridge-activity-repair.ts` TERMINAL TRANSITIONS — every path that moves a
 * logical `bridge_fill_expected` row OUT of `pending`, split out (move-only)
 * once `bridge-activity-repair-sweep.ts` approached the repo's 500-line cap
 * while gaining the DeBridge fill-hash recovery lane. The sweep now owns
 * scheduling + observation + dispatch; this module owns what a terminal
 * observation DOES to the row:
 *
 *   - `confirmVerifiedFill` — B4 independent on-chain proof BEFORE any confirm,
 *     the multi-fill audit append (Blocker 9), and the C3 side-effect ordering
 *     (reveal-clear → extra fills → balance enqueue, Blocker 11);
 *   - `terminalizeRefund` — verify → write evidence → terminalize (Blocker 8);
 *   - `terminalizeProviderFailure` — provider-terminal failure, no evidence row.
 *
 * See `bridge-activity-repair.ts`'s module doc for the full design rationale.
 * Pure over the injected `BridgeRepairDeps` port — no IO of its own.
 */

import type { CasResult } from "@vex-agent/db/repos/agent-activity.js";
import { summarizeProtocolError } from "@vex-agent/tools/protocols/runtime/errors.js";
import logger from "@utils/logger.js";
import {
  KHALANI_EVIDENCE_SOURCE,
  RELAY_EVIDENCE_SOURCE,
  type BridgeObservation,
  type BridgeRepairDeps,
  type BridgeSweepRow,
  type MutableSweepCounters,
  toVerificationStallReason,
} from "./bridge-activity-repair-contracts.js";

/**
 * The DeBridge fill-hash recovery lane (F2): a Khalani order routed through
 * deBridge reports `filled` while carrying ONLY its deposit transaction — the
 * destination hash exists nowhere in the Khalani record and lives only in
 * deBridge's stats API, keyed by the order's `externalOrderId`.
 *
 * When the mapper attached a recovery expectation (DeBridge route + an external
 * order id), ask for the hash; the dep proves the DLN record settles exactly our
 * destination before returning anything. A recovered hash then goes through the
 * UNCHANGED confirm path, so the independent on-chain proof still gates the
 * confirm — this lane can only ever supply a candidate hash, never a
 * confirmation. Anything else (no recovery expectation, or a refused lookup)
 * leaves the row precisely as before: pending, with the dossier-§5 anomaly
 * logged. The lookup must not throw into the sweep batch; a thrown error is
 * scrubbed and treated as a refusal.
 */
export async function recoverDebridgeFillHash(
  logical: BridgeSweepRow,
  observation: Extract<BridgeObservation, { kind: "filled_no_hash" }>,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;
  const lookup = observation.debridgeFillRecovery;

  if (lookup) {
    let recovered: { txHash: string } | null = null;
    try {
      recovered = await deps.fetchDebridgeFillHash(lookup);
    } catch (err) {
      logger.warn("bridge.repair.debridge_lookup_failed", {
        executionId,
        error: summarizeProtocolError(err).message,
      });
    }
    if (recovered) {
      logger.info("bridge.repair.debridge_hash_recovered", { executionId, protocol: logical.protocol });
      await confirmVerifiedFill(
        logical,
        {
          kind: "confirmable",
          providerStatus: observation.providerStatus,
          fillTxHashes: [recovered.txHash],
          destChainId: lookup.expectedDestChainId,
          destChainFamily: lookup.expectedDestChainFamily,
        },
        deps,
        counters,
      );
      return;
    }
  }

  // dossier §5: provider claims filled but produced no fill hash we can prove —
  // the one shape we must NEVER convert to a confirmation. Stay pending + anomaly.
  logger.warn("bridge.repair.filled_without_hash", {
    executionId,
    protocol: logical.protocol,
    providerStatus: observation.providerStatus,
    recoveryAttempted: lookup !== undefined,
  });
  await deps.noteVerificationInconclusive(logical.id, "filled_without_hash");
  counters.stillPending++;
}

export async function confirmVerifiedFill(
  logical: BridgeSweepRow,
  observation: Extract<BridgeObservation, { kind: "confirmable" }>,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;
  const [primaryHash, ...additionalHashes] = observation.fillTxHashes;
  if (!primaryHash) {
    // Defensive: the mapper never emits `confirmable` with an empty list.
    counters.stillPending++;
    return;
  }

  // B4: independent on-chain proof BEFORE any confirm. A failed check keeps the
  // row pending — the provider's word alone is never enough. The recipient is
  // NEVER substituted with the source wallet (Blocker 7): it is passed as stored
  // (null when unstored → amount-decode named-degraded).
  const verification = await deps.verifyFill({
    protocol: logical.protocol,
    txHash: primaryHash,
    expectedChainId: observation.destChainId,
    chainFamily: observation.destChainFamily,
    tokenOutAddress: logical.tokenOutAddress,
    recipient: null,
  });
  if (!verification.verified) {
    logger.warn("bridge.repair.fill_unverified", {
      executionId,
      protocol: logical.protocol,
      providerStatus: observation.providerStatus,
      reason: verification.reason ?? "verification_failed",
    });
    await deps.noteVerificationInconclusive(logical.id, toVerificationStallReason(verification.reason));
    counters.stillPending++;
    return;
  }

  const evidenceSource = logical.protocol === "relay" ? RELAY_EVIDENCE_SOURCE : KHALANI_EVIDENCE_SOURCE;
  const outcome = await deps.confirmExpectedFill({
    executionId,
    txHash: primaryHash,
    evidenceSource,
    providerStatus: observation.providerStatus,
    // Q2/B4: executed_* is set ONLY when the verifier decoded it against the stored
    // token + recipient; otherwise it stays NULL and the quoted amounts remain estimates.
    executedAmountInHuman: verification.executedAmountInHuman,
    executedAmountInRaw: verification.executedAmountInRaw,
    executedAmountOutHuman: verification.executedAmountOutHuman,
    executedAmountOutRaw: verification.executedAmountOutRaw,
  });

  if (!outcome.applied) {
    // A concurrent process (another sweep instance) already confirmed it.
    logDuplicateCas(executionId, "confirm", outcome);
    return;
  }

  counters.confirmed++;

  // C3 ORDERING (Blocker 11): clear the reveal FIRST (in-memory, best-effort) so a
  // later enqueue failure never strands a still-revealed confirmed route; the
  // recovery path re-clears it too.
  if (logical.protocol === "relay" && logical.sessionId && logical.normalizedRoute) {
    deps.clearRelayReveal(logical.sessionId, logical.normalizedRoute);
  }

  // B2/B8 (Blocker 9): every ADDITIONAL provider fill hash becomes a verified
  // `bridge_fill_observed` audit row (dedup by hash). An append failure here is
  // audit-only — it never blocks the confirm or the enqueue.
  for (const extraHash of additionalHashes) {
    const extraVerification = await deps.verifyFill({
      protocol: logical.protocol,
      txHash: extraHash,
      expectedChainId: observation.destChainId,
      chainFamily: observation.destChainFamily,
      tokenOutAddress: logical.tokenOutAddress,
      recipient: null,
    });
    if (!extraVerification.verified) {
      logger.warn("bridge.repair.extra_fill_unverified", {
        executionId,
        protocol: logical.protocol,
        reason: extraVerification.reason ?? "verification_failed",
      });
      continue;
    }
    try {
      await deps.appendFillObserved({
        executionId,
        protocol: logical.protocol,
        chainId: observation.destChainId,
        chainFamily: observation.destChainFamily,
        txHash: extraHash,
        evidenceSource,
        providerStatus: observation.providerStatus,
      });
    } catch (err) {
      logger.warn("bridge.repair.extra_fill_append_failed", {
        executionId,
        error: summarizeProtocolError(err).message,
      });
    }
  }

  // C3 (Blocker 11): enqueue LAST, and a failure here leaves a RECOVERABLE state —
  // the row is already confirmed and the reveal already cleared, so
  // reconcileBalanceEnqueues re-enqueues it next sweep. Swallow (scrubbed) rather
  // than abort the whole batch on one bad enqueue.
  try {
    await deps.enqueueBalanceRefresh({ namespace: logical.protocol, executionId });
  } catch (err) {
    logger.warn("bridge.repair.enqueue_failed", {
      executionId,
      error: summarizeProtocolError(err).message,
    });
  }
}

export async function terminalizeRefund(
  logical: BridgeSweepRow,
  observation: Extract<BridgeObservation, { kind: "refunded" }>,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const executionId = logical.protocolExecutionId;

  if (observation.refundTxHash) {
    // B4 (Blocker 8): verify the refund receipt/signature BEFORE writing a
    // confirmed evidence row. An unverifiable refund (not mined yet / reverted)
    // keeps the WHOLE row pending — no terminalization, retried next sweep (the
    // provider keeps returning refunded + the hash; no permanent loss).
    const verification = await deps.verifyFill({
      protocol: logical.protocol,
      txHash: observation.refundTxHash,
      expectedChainId: observation.refundChainId,
      chainFamily: observation.refundChainFamily,
      tokenOutAddress: null,
      recipient: null,
    });
    if (!verification.verified) {
      logger.warn("bridge.repair.refund_unverified", {
        executionId,
        protocol: logical.protocol,
        providerStatus: observation.providerStatus,
        reason: verification.reason ?? "verification_failed",
      });
      await deps.noteVerificationInconclusive(logical.id, toVerificationStallReason(verification.reason));
      counters.stillPending++;
      return;
    }

    // Evidence write must SUCCEED before we terminalize (Blocker 8). A write
    // failure keeps everything pending for the next sweep (dedup makes the retry a
    // harmless no-op if the row did land).
    try {
      await deps.appendRefundEvidence({
        executionId,
        protocol: logical.protocol,
        chainId: observation.refundChainId,
        chainFamily: observation.refundChainFamily,
        txHash: observation.refundTxHash,
        evidenceSource: logical.protocol === "relay" ? RELAY_EVIDENCE_SOURCE : KHALANI_EVIDENCE_SOURCE,
        providerStatus: observation.providerStatus,
      });
    } catch (err) {
      logger.warn("bridge.repair.refund_evidence_failed", {
        executionId,
        error: summarizeProtocolError(err).message,
      });
      await deps.noteVerificationInconclusive(logical.id, "refund_evidence_write_failed");
      counters.stillPending++;
      return;
    }
  }

  // refundTxHash present + verified + evidence written, OR the named-gap case
  // (no hash, keyless Relay) with route correlation already passed — terminalize.
  const outcome = await deps.failLogical(
    logical.id,
    "bridge_refunded",
    `provider refund — funds returned to refundTo (${observation.providerStatus})`,
  );
  if (outcome.applied) {
    counters.failed++;
    counters.refunded++;
  } else {
    logDuplicateCas(executionId, "fail", outcome);
  }
}

/** A provider-terminal failure: terminalize `bridge_failed`, no evidence row (there is no leg to prove). */
export async function terminalizeProviderFailure(
  logical: BridgeSweepRow,
  observation: Extract<BridgeObservation, { kind: "failed" }>,
  deps: BridgeRepairDeps,
  counters: MutableSweepCounters,
): Promise<void> {
  const outcome = await deps.failLogical(
    logical.id,
    "bridge_failed",
    `provider-terminal failure (${observation.providerStatus})`,
  );
  if (outcome.applied) counters.failed++;
  else logDuplicateCas(logical.protocolExecutionId, "fail", outcome);
}

function logDuplicateCas(executionId: number, attempted: "confirm" | "fail", outcome: CasResult): void {
  // Not a failure — a concurrent sweep instance already settled this row.
  logger.info("bridge.repair.duplicate_cas_miss", {
    executionId,
    attempted,
    currentStatus: outcome.row.status,
  });
}
