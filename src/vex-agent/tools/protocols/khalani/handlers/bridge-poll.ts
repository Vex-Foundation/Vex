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
}

export async function interpretPoll(input: InterpretPollInput): Promise<ToolResult> {
  const { poll, orderId, depositTxHash, pendingBase, recordedLegs, toChainName } = input;

  const withFill = (status: string): RecordedLeg[] => [
    ...recordedLegs,
    { role: "bridge_fill_expected", chain: toChainName, txHash: null, status },
  ];

  if (poll.kind === "unavailable") {
    logger.warn("khalani.bridge.status_unverifiable", { orderId });
    return bridgeResult({
      ...pendingBase, success: false, status: "pending", orderId, depositTxHash,
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
    return bridgeResult({ ...pendingBase, success: false, status: poll.status, orderId, depositTxHash, message, legs: withFill(poll.status) });
  }

  if (poll.kind === "terminal" && poll.status === "filled") {
    // R6/B4: NEVER fabricate a confirmed fill. Provider `filled` is left PENDING
    // for W4's independent RPC verification (the verified-confirm seam) — this
    // handler has no verified path, so it only reports the provider view.
    return bridgeResult({
      ...pendingBase, success: false, status: "filled_unverified", orderId, depositTxHash,
      message: `Khalani reports this bridge as filled — the deposit (${depositTxHash}) went through and delivery is in progress. Verification is pending (confirmed independently by the background tracker); do not re-bridge.`,
      legs: withFill("filled_unverified"),
    });
  }

  // Non-terminal at window close (created/deposited/published/refund_pending).
  const settlingMessage = poll.status === "refund_pending"
    ? `The deposit (${depositTxHash}) went through but Khalani's last status was "refund_pending": a refund is IN FLIGHT and the destination amount has NOT arrived. Tracked automatically — do not re-bridge.`
    : `The deposit (${depositTxHash}) went through and the bridge is still settling (last status "${poll.status}"). It is tracked automatically — do not re-bridge.`;
  return bridgeResult({
    ...pendingBase, success: false, status: "pending", orderId, depositTxHash,
    message: settlingMessage, legs: withFill("pending"),
  });
}
