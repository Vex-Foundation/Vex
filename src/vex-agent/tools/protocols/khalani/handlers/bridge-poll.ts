/**
 * `bridge.ts` in-turn provider order-poll interpretation — split out (Card
 * C5, move-only) once the parent file crossed the repo's 500-line cap. See
 * `bridge.ts`'s own module doc ("VERIFICATION SEAM LEFT FOR W4") for why
 * this NEVER fabricates a confirmed fill: a provider `filled`/`refunded`/
 * `failed` is reported truthfully but the logical row stays pending for the
 * W4 sweep's independent RPC verification (R6/B4/Q2).
 */

import { pollKhalaniOrderToTerminal } from "@tools/khalani/order-status.js";
import type { ToolResult } from "../../../types.js";
import logger from "@utils/logger.js";
import { type AmountView, type BridgeVexFeeView, bridgeResult, type RecordedLeg } from "./bridge-support.js";
import {
  noteHandlerPendingReason,
  recordBridgeProviderObservation,
  NO_PROVIDER_STATUS_OBSERVED,
} from "@vex-agent/tools/protocols/runtime/pending-provenance.js";

/** This module reports for one tool only; its log/telemetry prefix. */
const TOOL_ID = "khalani.bridge";

// ── Poll interpretation ──────────────────────────────────────────────

export interface InterpretPollInput {
  poll: Awaited<ReturnType<typeof pollKhalaniOrderToTerminal>>;
  orderId: string;
  depositTxHash: string;
  pendingBase: {
    executionId: number; fromChainName: string; toChainName: string;
    routeType: string; etaSeconds: number; amountIn: AmountView; amountOut: AmountView;
    vexFee: BridgeVexFeeView;
    nativeCost: Record<string, unknown>;
  };
  recordedLegs: RecordedLeg[];
  toChainName: string;
  /** The logical `bridge_fill_expected` row this poll is reporting about. */
  logicalRowId: number;
}

/**
 * The provider status this window actually READ, or `null` when it read none.
 *
 * An `unavailable` window means every status call threw; an `aborted` window
 * before the first read observed nothing. Neither may be recorded as a status —
 * that is the difference between "the provider says pending" and "we could not
 * ask", which this handler already refuses to collapse in its prose.
 */
function observedStatusFrom(poll: InterpretPollInput["poll"]): string | null {
  switch (poll.kind) {
    case "terminal":
    case "pending":
      return poll.status;
    case "aborted":
      return poll.lastObserved;
    case "unavailable":
      return null;
  }
}

export async function interpretPoll(input: InterpretPollInput): Promise<ToolResult> {
  const { poll, orderId, depositTxHash, pendingBase, recordedLegs, toChainName } = input;
  const { executionId } = pendingBase;

  const withFill = (status: string): RecordedLeg[] => [
    ...recordedLegs,
    { role: "bridge_fill_expected", chain: toChainName, txHash: null, status },
  ];

  // R1 Step 4: the logical row stays pending on EVERY arm below, so say why once,
  // here, where the deposit is known broadcast. `provider_fill_unverified` is the
  // truthful statement in all four cases — even a provider-terminal `filled` is
  // the provider's word, which this handler has no path to verify.
  await noteHandlerPendingReason(TOOL_ID, input.logicalRowId, "provider_fill_unverified");

  // R1 Step 3a: persist what the provider actually said, so `AgentScan` carries
  // it at return instead of waiting for the fast lane's next sweep. An
  // `unavailable` window read NOTHING, and an abort before the first read has
  // nothing to record either — inventing a status for those would be the exact
  // claim-more-than-the-evidence failure this step exists to remove.
  const observedStatus = observedStatusFrom(poll);
  const providerStatusRecording = observedStatus === null
    ? NO_PROVIDER_STATUS_OBSERVED
    : await recordBridgeProviderObservation({
      toolId: TOOL_ID, executionId, providerStatus: observedStatus,
    });

  if (poll.kind === "aborted") {
    // The operator stopped the run while we were WATCHING. The deposit is
    // broadcast and the row is pending for the background tracker exactly as in
    // every other non-terminal outcome — the only thing lost is this turn's
    // observation, and saying so is the truthful claim. Never "the bridge was
    // stopped": nothing about the bridge was cancelled.
    logger.info("khalani.bridge.status_poll_aborted", { orderId });
    const observed = poll.lastObserved === null
      ? "no status was read before the stop"
      : `last status read was "${poll.lastObserved}"`;
    return bridgeResult({
      ...pendingBase, success: false, status: "pending", orderId, depositTxHash, providerStatusRecording,
      message: `The deposit was broadcast (${depositTxHash}) and you stopped the run while its delivery was being watched (${observed}). The bridge itself was NOT cancelled and is tracked automatically — do not re-bridge; verify via orderId=${orderId} if needed.`,
      legs: withFill("pending"),
    });
  }

  if (poll.kind === "unavailable") {
    logger.warn("khalani.bridge.status_unverifiable", { orderId });
    return bridgeResult({
      ...pendingBase, success: false, status: "pending", orderId, depositTxHash, providerStatusRecording,
      message: `The deposit was broadcast (${depositTxHash}) but Khalani's order status was unreachable this turn. Delivery is UNCONFIRMED and tracked automatically — do not re-bridge; verify via orderId=${orderId} if needed.`,
      legs: withFill("pending"),
    });
  }

  if (poll.kind === "terminal" && (poll.status === "failed" || poll.status === "refunded")) {
    // ARCHITECTURAL (FIX-ROUND-1): the in-turn poll NEVER terminalizes the logical
    // row from provider status. W4 owns ALL terminal transitions — it verifies and
    // APPENDS refund/failure evidence before terminalizing, and keeps the row
    // pending if the evidence write fails, so a known refund hash is never lost.
    // Here we only REPORT the provider-terminal status truthfully; the row stays
    // pending and is reconciled by the background tracker.
    const message = poll.status === "refunded"
      ? "Khalani reports this bridge as refunded: the destination amount did NOT arrive; funds are being returned toward the refund address. Verification and recording are in progress and tracked automatically — do not re-bridge; money back is not a successful bridge."
      : "Khalani reports this bridge as failed: the destination amount did NOT arrive. Verification and recording are in progress and tracked automatically — do not re-bridge; verify balances via the order id before retrying.";
    return bridgeResult({ ...pendingBase, success: false, status: poll.status, orderId, depositTxHash, message, legs: withFill(poll.status), providerStatusRecording });
  }

  if (poll.kind === "terminal" && poll.status === "filled") {
    // R6/B4: NEVER fabricate a confirmed fill. Provider `filled` is left PENDING
    // for W4's independent RPC verification (the verified-confirm seam) — this
    // handler has no verified path, so it only reports the provider view.
    return bridgeResult({
      ...pendingBase, success: false, status: "filled_unverified", orderId, depositTxHash, providerStatusRecording,
      message: `Khalani reports this bridge as filled — the deposit (${depositTxHash}) went through and delivery is in progress. Verification is pending (confirmed independently by the background tracker); do not re-bridge.`,
      legs: withFill("filled_unverified"),
    });
  }

  // Non-terminal at window close (created/deposited/published/refund_pending).
  const settlingMessage = poll.status === "refund_pending"
    ? `The deposit (${depositTxHash}) went through but Khalani's last status was "refund_pending": a refund is IN FLIGHT and the destination amount has NOT arrived. Tracked automatically — do not re-bridge.`
    : `The deposit (${depositTxHash}) went through and the bridge is still settling (last status "${poll.status}"). It is tracked automatically — do not re-bridge.`;
  return bridgeResult({
    ...pendingBase, success: false, status: "pending", orderId, depositTxHash, providerStatusRecording,
    message: settlingMessage, legs: withFill("pending"),
  });
}
