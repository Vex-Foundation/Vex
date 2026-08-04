/**
 * Every agent-facing body `relay.bridge` can return — the rejected, in-flight,
 * pending, failed, unconfirmed, not-attempted and interrupted shapes — plus the
 * hashless pre-sign failure row that accompanies the rejected one.
 *
 * TRUTHFUL OUTPUT (B5/§4) is this module's single responsibility:
 * success-while-pending is FORBIDDEN, and every body here returns
 * `success:false` for exactly that reason.
 *
 * Extracted verbatim from `../bridge.ts` as part of a façade-preserving
 * structural split (SPEC wave 0R.2). `../bridge.ts` remains the public entry
 * point.
 */

import type { BridgeFeeDisclosure } from "@tools/bridge-fee/index.js";
import type { RelayPollError, RelayPollResult } from "@tools/relay/execute.js";
import {
  createBridgePreBroadcastFailure,
  type AgentActivityFailureCode,
  type AgentActivityLegInput,
  type BridgeRouteEndpoints,
} from "@vex-agent/db/repos/agent-activity.js";
import type { ProviderStatusRecording } from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import type { ToolResult } from "../../../../types.js";
import {
  bridgeSummaryLine,
  type BridgeAmountDisplay,
  type BridgeEndpointDisplay,
  type BridgeOutputLeg,
} from "../bridge-output.js";
import type { OriginBroadcast } from "./broadcast.js";
import type { RelayFeeCollection } from "./fee-leg.js";
import { BRIDGE_TOOL_ID, PROTOCOL } from "./constants.js";

/** A never-completed bridge's fee disclosure — nothing was ever charged on these paths. */
export type FeeNotTaken = BridgeFeeDisclosure & RelayFeeCollection;

/** Pre-sign gate/validation failure → hashless `definitively_failed` logical row (R15/C1). */
export async function failPreSign(
  route: BridgeRouteEndpoints,
  walletAddress: string,
  sessionId: string,
  params: Record<string, unknown>,
  failureCode: AgentActivityFailureCode,
  reason: string,
  from: BridgeEndpointDisplay,
  to: BridgeEndpointDisplay,
  tokenIn: AgentActivityLegInput | undefined,
  tokenOut: AgentActivityLegInput | undefined,
): Promise<ToolResult> {
  const { executionId } = await createBridgePreBroadcastFailure({
    toolId: BRIDGE_TOOL_ID,
    namespace: PROTOCOL,
    protocol: PROTOCOL,
    intentParams: params,
    walletAddress,
    sessionId,
    route,
    tokenIn,
    tokenOut,
    failureCode,
    failureReason: reason,
  });
  const body = {
    status: "rejected",
    summary: `Relay could not bridge from ${from.name} to ${to.name}: ${reason}`,
    message: `${reason} No funds were moved and nothing was signed.`,
    fromChain: from,
    toChain: to,
  };
  return { success: false, output: JSON.stringify(body, null, 2), data: { ...body, _executionId: executionId } };
}

/** A prior bridge already occupies this wallet+session+route slot (C2). Nothing recorded for this attempt. */
export function inFlightResult(from: BridgeEndpointDisplay, to: BridgeEndpointDisplay): ToolResult {
  const body = {
    status: "in_flight",
    summary: `A bridge is already in flight for this route (${from.name} → ${to.name}).`,
    message:
      `A bridge is already in flight for this route (${from.name} → ${to.name}). `
      + "Wait for it to finalize before starting another — Vex is tracking it automatically. Do NOT re-bridge.",
    fromChain: from,
    toChain: to,
  };
  return { success: false, output: JSON.stringify(body, null, 2), data: body };
}

export function outputLegs(
  broadcasts: readonly OriginBroadcast[],
  from: BridgeEndpointDisplay,
  to: BridgeEndpointDisplay,
  fillStatus: string,
  fillTxHash: string | null,
): BridgeOutputLeg[] {
  const legs: BridgeOutputLeg[] = broadcasts.map((b) => ({
    role: b.role,
    chainId: from.id,
    chainName: from.name,
    txHash: b.txHash,
    status: b.status,
  }));
  legs.push({ role: "bridge_fill_expected", chainId: to.id, chainName: to.name, txHash: fillTxHash, status: fillStatus });
  return legs;
}

/** The bounded, non-sensitive rendering of a status-poll failure. */
function describePollError(lastError: RelayPollError | null): string {
  if (lastError === null) return "";
  const parts = [lastError.code, lastError.providerCode, lastError.httpStatus === undefined ? undefined : `HTTP ${lastError.httpStatus}`];
  return ` (last error: ${parts.filter((p) => p !== undefined).join(", ")})`;
}

/** Per-hop explorer refs (model-invisible UI deep-links) for Vex's OWN origin broadcasts. */
function explorerRefs(broadcasts: readonly OriginBroadcast[], from: BridgeEndpointDisplay) {
  return broadcasts.map((b) => ({ chain: String(from.id), txRef: b.txHash }));
}

/**
 * Truthful pending result (B5/C3): the origin deposit was broadcast but the
 * bridge is NOT final — `success:false` so the runtime never seeds balances for
 * a pending bridge (C3) and the model never reads it as completion. The logical
 * row stays pending for the W4 sweep. The last in-turn provider status is
 * surfaced honestly (incl. a refund/failure distinction) but NEVER terminalizes
 * the durable row here.
 */
export function pendingResult(args: {
  executionId: number;
  requestId: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  inSide: BridgeAmountDisplay;
  outSide: BridgeAmountDisplay;
  feeUsdByBucket: Record<string, string>;
  broadcasts: readonly OriginBroadcast[];
  poll: RelayPollResult | null;
  depositUnconfirmed: boolean;
  vexFee: BridgeFeeDisclosure;
  feeCollection: RelayFeeCollection;
  /** O-8 — what the durable provider-status write did, disclosed rather than assumed. */
  providerStatusRecording: ProviderStatusRecording;
}): ToolResult {
  const { executionId, requestId, from, to, inSide, outSide, feeUsdByBucket, broadcasts, poll } = args;
  const providerStatus = poll?.observed ? poll.status : null;
  const destinationTxHashes = poll?.destinationTxHashes ?? [];
  const fillTxHash = destinationTxHashes[0] ?? null;
  const inTxHashes = broadcasts.map((b) => b.txHash);

  const depositState = args.depositUnconfirmed
    ? "the origin deposit was broadcast but Vex could not yet confirm it on-chain"
    : "the origin deposit is confirmed on-chain";
  const failReason = poll?.failReason ?? null;
  const refundFailReason = poll?.refundFailReason ?? null;
  // Relay's OWN reason, in its documented closed vocabulary, appended verbatim
  // (W2c): `BLOCKED_WALLET` — funds NOT auto-refunded, compliance review — and
  // `TTL_EXPIRED` — refunded — were reported with the same sentence before this.
  const reasonSuffix =
    failReason === null && refundFailReason === null
      ? ""
      : ` Relay's reason: ${[failReason, refundFailReason === null ? null : `refund ${refundFailReason}`].filter((r) => r !== null).join(", ")}.`;
  let message: string;
  let fillStatus = "pending";
  if (providerStatus === "refund") {
    fillStatus = "reported_refund";
    message =
      `Relay currently reports this bridge as REFUNDED — the destination amount did NOT arrive and funds are being returned to your refund address.${reasonSuffix} `
      + `Money back is NOT a successful bridge. Vex will independently verify and finalize this record automatically. Do NOT re-bridge.`;
  } else if (providerStatus === "failure") {
    fillStatus = "reported_failure";
    message =
      `Relay currently reports this bridge as FAILED — the destination amount did NOT arrive.${reasonSuffix} `
      + `Vex will independently verify and finalize this record automatically; check the request id before any manual action. Do NOT re-bridge.`;
  } else if (providerStatus === "success") {
    fillStatus = "reported_success";
    message =
      `${depositState}; Relay reports the destination fill succeeded. Vex will independently verify and finalize the record automatically — `
      + `treat it as in progress until then. Do NOT re-bridge.`;
  } else {
    // The in-turn poll is bounded to a few seconds and is INFORMATIONAL: the
    // background sweep owns confirmation. Say so, and name the waiting pattern —
    // an agent told only "in progress" re-polls in a loop and burns the turn.
    message =
      `${depositState}; the destination fill is in progress${providerStatus ? ` (last status: ${providerStatus})` : ""} — Vex is tracking it automatically `
      + `and will finalize the record once the fill is independently verified. This result was returned as soon as the short in-turn check ended; `
      + `Vex's background sweep owns confirmation, so do NOT poll or re-run this tool in a loop — use loop_defer if you need to wait. Do NOT re-bridge.`;
  }
  // `observed:false` means EVERY status call in the window threw. That is NOT
  // "still pending", and collapsing it to `providerStatus: null` made the two
  // indistinguishable. The last failure is a bounded code + status only.
  if (poll !== null && !poll.observed) {
    message += ` NOTE: Relay's status API was unreachable this turn${describePollError(poll.lastError)}, so no provider status was read — that is NOT the same as "still pending". The bridge itself is unaffected; Vex's background sweep owns confirmation.`;
  }

  const body = {
    status: "pending",
    summary: `${bridgeSummaryLine(inSide, from, to)}. ${depositState}; destination fill in progress — tracked automatically.`,
    message,
    fromChain: from,
    toChain: to,
    requestId,
    providerStatus,
    /** Relay's own closed-vocabulary reason, or null when it sent none. */
    providerFailReason: failReason,
    providerRefundFailReason: refundFailReason,
    /** True when EVERY status call this turn threw — no provider status was read. */
    providerStatusUnreachable: poll !== null && !poll.observed,
    // O-8: whether the status above actually reached `agent_scan`, and if not,
    // WHY — `null` means none was read, so there was nothing to record. A write
    // that silently did nothing does not meet "agent_scan is fed at return".
    providerStatusRecorded: args.providerStatusRecording.providerStatusRecorded,
    providerStatusRecordedReason: args.providerStatusRecording.providerStatusRecordedReason,
    legs: outputLegs(broadcasts, from, to, fillStatus, fillTxHash),
    inTxHashes,
    txHashes: destinationTxHashes,
    amounts: { in: inSide, out: outSide },
    // Disclosure + collection outcome. `collection` describes Vex's revenue
    // only — it never qualifies whether the user's bridge worked.
    vexFee: { ...args.vexFee, ...args.feeCollection },
    feeUsdByBucket,
  };
  return {
    success: false,
    output: JSON.stringify(body, null, 2),
    data: {
      ...body,
      _executionId: executionId,
      // Per-hop explorer refs (model-invisible UI deep-links): only Vex's OWN
      // verified origin broadcasts are coherently chain-paired; the provider
      // destination hash is unverified and stays out of this clickable set.
      _explorerRefs: explorerRefs(broadcasts, from),
    },
  };
}

/** The origin approve/deposit reverted on-chain — nothing bridged, nothing charged. */
export function originRevertedResult(args: {
  executionId: number;
  requestId: string;
  role: string;
  txHash: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  broadcasts: readonly OriginBroadcast[];
  vexFee: FeeNotTaken;
}): ToolResult {
  const { executionId, requestId, role, txHash, from, to, broadcasts } = args;
  const body = {
    status: "failed",
    summary: `Relay bridge failed: the origin ${role} reverted on-chain. No funds were bridged.`,
    message:
      `The origin ${role} transaction (${txHash}) reverted on-chain — the bridge did not execute and no destination fill will occur. No funds left the origin chain.`,
    fromChain: from,
    toChain: to,
    requestId,
    vexFee: args.vexFee,
    legs: outputLegs(broadcasts, from, to, "not_reached", null),
    inTxHashes: broadcasts.map((b) => b.txHash),
  };
  return {
    success: false,
    output: JSON.stringify(body, null, 2),
    data: { ...body, _executionId: executionId, _explorerRefs: explorerRefs(broadcasts, from) },
  };
}

/** The token approval could not be confirmed, so the deposit was never signed. */
export function approvalUnconfirmedResult(args: {
  executionId: number;
  txHash: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  broadcasts: readonly OriginBroadcast[];
  vexFee: FeeNotTaken;
}): ToolResult {
  const { executionId, txHash, from, to, broadcasts } = args;
  const body = {
    status: "unconfirmed",
    summary: `Relay bridge not attempted: the token approval could not be confirmed.`,
    message:
      `The token approval (${txHash}) could not be confirmed on-chain, so the bridge deposit was NOT signed and no funds were bridged. The approval may still settle; do NOT retry until you have verified its status.`,
    fromChain: from,
    toChain: to,
    vexFee: args.vexFee,
    legs: outputLegs(broadcasts, from, to, "not_reached", null),
    inTxHashes: broadcasts.map((b) => b.txHash),
  };
  return {
    success: false,
    output: JSON.stringify(body, null, 2),
    data: { ...body, _executionId: executionId, _explorerRefs: explorerRefs(broadcasts, from) },
  };
}

/**
 * A leg refused because its estimate never succeeded after an approve this same
 * bridge confirmed is NOT an interruption of unknown scope: nothing was signed
 * for it, every remaining row (including the logical fill row, so the in-flight
 * guard is released) is finalized "not attempted", and re-running is safe.
 * Telling an agent otherwise is what turned a transient RPC lag into a permanent
 * refusal (live 2026-07-25).
 */
export function gasEstimateNotAttemptedResult(args: {
  executionId: number;
  requestId: string;
  refusedRole: string;
  guidance: string;
  safe: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  broadcasts: readonly OriginBroadcast[];
  vexFee: FeeNotTaken;
}): ToolResult {
  const { executionId, requestId, refusedRole, from, to, broadcasts } = args;
  const body = {
    status: "not_attempted",
    summary: `Relay bridge not attempted: the origin ${refusedRole} could not be gas-estimated.`,
    message: `The origin ${refusedRole} could not be gas-estimated, so it was refused before signing. ${args.guidance} The node reported: ${args.safe}`,
    fromChain: from,
    toChain: to,
    requestId,
    vexFee: args.vexFee,
    legs: outputLegs(broadcasts, from, to, "not_reached", null),
    inTxHashes: broadcasts.map((b) => b.txHash),
  };
  return { success: false, output: JSON.stringify(body, null, 2), data: { ...body, _executionId: executionId, retryable: true } };
}

/**
 * A step refused because Vex could not attribute its `tx.value` is NOT an
 * interruption of unknown scope, and must never be reported as one: the generic
 * interrupted body says "check the record before any further action", which an
 * autonomous agent cannot act on and which reads as "funds may be in flight".
 * Nothing was signed for the refused step, every remaining row is finalized
 * "not attempted", and the agent is told the one thing that can change the
 * outcome — a fresh quote.
 */
export function nativeValueNotAttemptedResult(args: {
  executionId: number;
  requestId: string;
  refusedLabel: string;
  message: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  broadcasts: readonly OriginBroadcast[];
  vexFee: FeeNotTaken;
}): ToolResult {
  const { executionId, requestId, refusedLabel, from, to, broadcasts } = args;
  const body = {
    status: "not_attempted",
    summary: `Relay bridge not attempted: the origin ${refusedLabel} carried native currency Vex could not account for.`,
    message: args.message,
    fromChain: from,
    toChain: to,
    requestId,
    vexFee: args.vexFee,
    legs: outputLegs(broadcasts, from, to, "not_reached", null),
    inTxHashes: broadcasts.map((b) => b.txHash),
  };
  return {
    success: false,
    output: JSON.stringify(body, null, 2),
    data: {
      ...body,
      _executionId: executionId,
      // A retry only helps with a DIFFERENT quote — never a re-send of this
      // one, which is deterministically refused again.
      retryable: false,
      ...(broadcasts.length > 0 ? { _explorerRefs: explorerRefs(broadcasts, from) } : {}),
    },
  };
}

/** An internal error interrupted the bridge after the intent already existed. */
export function interruptedResult(args: {
  executionId: number;
  safe: string;
  from: BridgeEndpointDisplay;
  to: BridgeEndpointDisplay;
  vexFee: FeeNotTaken;
}): ToolResult {
  const { executionId, from, to } = args;
  const body = {
    status: "interrupted",
    summary: "Relay bridge was interrupted after it was already recorded.",
    message: `An internal error interrupted the bridge after it was recorded (${args.safe}). Check the record (execution ${executionId}) before any further action.`,
    fromChain: from,
    toChain: to,
    vexFee: args.vexFee,
  };
  return { success: false, output: JSON.stringify(body, null, 2), data: { ...body, _executionId: executionId } };
}
