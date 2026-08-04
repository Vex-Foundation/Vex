/**
 * W2c — the pending body must distinguish the three things it used to collapse:
 *
 *  1. "Relay says still in flight"  (observed, non-terminal status)
 *  2. "Relay's status API was UNREACHABLE this turn" (`observed:false`) — before
 *     this wave both rendered as `providerStatus: null`, indistinguishable;
 *  3. WHY a bridge failed or refunded (`failReason` / `refundFailReason`).
 *     `BLOCKED_WALLET` (funds NOT auto-refunded, compliance review) and
 *     `TTL_EXPIRED` (refunded) are wildly different user outcomes that were
 *     reported with the same sentence.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("@vex-agent/db/repos/agent-activity.js", () => ({
  createBridgePreBroadcastFailure: vi.fn(),
}));

import { pendingResult } from "@vex-agent/tools/protocols/relay/handlers/bridge/results.js";
import {
  NO_PROVIDER_STATUS_OBSERVED,
  type ProviderStatusRecording,
} from "@vex-agent/tools/protocols/runtime/pending-provenance.js";
import type { RelayPollResult } from "@tools/relay/execute.js";
import type {
  BridgeAmountDisplay,
  BridgeEndpointDisplay,
} from "@vex-agent/tools/protocols/relay/handlers/bridge-output.js";
import type { BridgeFeeDisclosure } from "@tools/bridge-fee/index.js";

const FROM: BridgeEndpointDisplay = { id: 8453, name: "Base" };
const TO: BridgeEndpointDisplay = { id: 4663, name: "Robinhood Chain" };
const AMOUNT: BridgeAmountDisplay = {
  token: "ETH",
  tokenAddress: "0x0000000000000000000000000000000000000000",
  amount: "0.0001",
  amountRaw: "100000000000000",
  usd: null,
};
/** These tests read the provider-signal sentences; no fee was taken on this bridge. */
const NO_FEE: BridgeFeeDisclosure = {
  charged: false,
  bps: 0,
  reason: "this suite exercises the provider-signal text, not the fee",
  bridgedAmountRaw: "100000000000000",
  totalDebitedRaw: "100000000000000",
  note: "no Vex fee was taken",
};

function body(
  poll: RelayPollResult | null,
  providerStatusRecording: ProviderStatusRecording = NO_PROVIDER_STATUS_OBSERVED,
): Record<string, unknown> {
  const result = pendingResult({
    providerStatusRecording,
    executionId: 1,
    requestId: "0xreq",
    from: FROM,
    to: TO,
    inSide: AMOUNT,
    outSide: AMOUNT,
    feeUsdByBucket: {},
    broadcasts: [{ role: "bridge_deposit", txHash: "0xdep", status: "confirmed" }],
    poll,
    depositUnconfirmed: false,
    vexFee: NO_FEE,
    feeCollection: { collection: "confirmed", collectionNote: "" },
  });
  return JSON.parse(result.output) as Record<string, unknown>;
}

function poll(overrides: Partial<RelayPollResult>): RelayPollResult {
  return {
    status: "pending",
    observed: true,
    destinationTxHashes: [],
    failReason: null,
    refundFailReason: null,
    lastError: null,
    ...overrides,
  };
}

describe("pendingResult — provider signals", () => {
  it("says the status API was UNREACHABLE, with the last error, instead of staying silent", () => {
    const out = body(poll({ observed: false, lastError: { code: "RELAY_RATE_LIMITED", httpStatus: 429 } }));
    expect(String(out.message)).toContain("unreachable");
    expect(String(out.message)).toContain("RELAY_RATE_LIMITED");
    expect(String(out.message)).toContain("429");
    expect(out.providerStatus).toBeNull();
  });

  it("does NOT claim unreachable when the status API answered", () => {
    const out = body(poll({ status: "submitted" }));
    expect(String(out.message)).not.toContain("unreachable");
    expect(out.providerStatus).toBe("submitted");
  });

  it("surfaces failReason on a reported failure", () => {
    const out = body(poll({ status: "failure", failReason: "BLOCKED_WALLET" }));
    expect(String(out.message)).toContain("BLOCKED_WALLET");
    expect(out.providerFailReason).toBe("BLOCKED_WALLET");
  });

  it("surfaces refundFailReason on a reported refund", () => {
    const out = body(poll({ status: "refund", failReason: "TTL_EXPIRED", refundFailReason: "AMOUNT_TOO_LOW_TO_REFUND" }));
    expect(String(out.message)).toContain("TTL_EXPIRED");
    expect(String(out.message)).toContain("AMOUNT_TOO_LOW_TO_REFUND");
  });

  it("never invents a reason Relay did not send", () => {
    const out = body(poll({ status: "failure" }));
    expect(out.providerFailReason).toBeNull();
    expect(String(out.message)).toContain("FAILED");
  });

  it("names loop_defer as the waiting pattern instead of inviting a re-poll loop", () => {
    const out = body(poll({ status: "submitted" }));
    expect(String(out.message)).toContain("loop_defer");
    expect(String(out.message)).toMatch(/do not poll|Do NOT poll/i);
  });

  it("tolerates a null poll (deposit unconfirmed — nothing was polled)", () => {
    const out = body(null);
    expect(out.providerStatus).toBeNull();
    expect(String(out.message)).not.toContain("unreachable");
  });
});

describe("pendingResult — O-8, whether the provider status actually reached agent_scan", () => {
  it("reports a recorded write", () => {
    const out = body(poll({ status: "success" }), {
      providerStatusRecorded: true, providerStatusRecordedReason: null,
    });
    expect(out.providerStatusRecorded).toBe(true);
    expect(out.providerStatusRecordedReason).toBeNull();
  });

  it("NAMES why a write did not land instead of returning a bare false", () => {
    // The whole point of O-8: an agent told only `false` cannot tell "the row is
    // already terminal" from "we could not write", and retries blind on both.
    const out = body(poll({ status: "success" }), {
      providerStatusRecorded: false, providerStatusRecordedReason: "stale_observation",
    });
    expect(out.providerStatusRecorded).toBe(false);
    expect(out.providerStatusRecordedReason).toBe("stale_observation");
  });

  it("says `nothing was read` as null — never as a failed write", () => {
    const out = body(poll({ observed: false }));
    expect(out.providerStatusRecorded).toBeNull();
    expect(out.providerStatusRecordedReason).toBeNull();
  });
});
