/**
 * Relay bridge execution PRIMITIVES — RE-PINNED to the origin-only staged
 * contract (Wave-3 W3b, B3). The old monolithic `executeRelayBridge` (validate
 * whole quote → broadcast a flat plan across `{origin, destination}` → poll) was
 * REMOVED: the agent_activity staged discipline now lives in the handler
 * (`vex-agent/tools/protocols/relay/handlers/bridge.ts`, covered by
 * relay-handlers/bridge.test.ts), and this tools-layer module exposes only the
 * origin-only EVM primitives.
 *
 * WHAT CHANGED + WHY (this file is the dedicated test of `src/tools/relay/execute.ts`):
 *  - the old fail-closed PHASE-1 coverage is re-pinned onto `planRelayStepTx`, and
 *    tightened to ORIGIN-ONLY (a destination-chain step is now REJECTED, not
 *    accepted — the old suite modeled the deposit on the destination chain, which
 *    was the pre-B3 leniency this migration fixes);
 *  - the old ordered-broadcast coverage moved to the handler staged suite;
 *  - the bounded-poll coverage is re-pinned onto `pollRelayIntentStatus`;
 *  - the `parseRequestIdFromCheckEndpoint` trust-parser coverage is PRESERVED
 *    verbatim (that function is byte-unchanged).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { getAddress } from "viem";

// pollRelayIntentStatus polls getRelayClient().getIntentStatus. planRelayStepTx +
// parseRequestIdFromCheckEndpoint are pure (no client). RELAY_TERMINAL_STATUSES /
// RELAY_INTENT_STATUS_PATH come from the real types/client constants.
const getIntentStatus = vi.fn();
vi.mock("@tools/relay/client.js", () => ({
  getRelayClient: () => ({ getIntentStatus: (...a: unknown[]) => getIntentStatus(...a) }),
  RELAY_INTENT_STATUS_PATH: "/intents/status/v3",
}));

import { planRelayStepTx, pollRelayIntentStatus, parseRequestIdFromCheckEndpoint } from "@tools/relay/execute.js";
import type { RelayStepNativeValueContext } from "@tools/relay/native-value.js";
import type { RelayStep } from "@tools/relay/types.js";

const ORIGIN = 8453;
const DESTINATION = 4663;
const FROM = getAddress("0x1111111111111111111111111111111111111111");
const TO = "0x2222222222222222222222222222222222222222";

/**
 * A native-in bridge of exactly the value these fixtures carry, so the
 * native-value gate (added phase-3 W3) attributes the whole `tx.value` to the
 * bridged principal and these ORIGIN-ONLY/shape cases keep testing what they
 * were written to test. The gate itself is covered in `native-value-gate.test.ts`.
 */
const NATIVE_IN: RelayStepNativeValueContext = {
  role: "bridge_deposit",
  originCurrency: "0x0000000000000000000000000000000000000000",
  tradeType: "EXACT_INPUT",
  bridgedAmountRaw: "1000",
};

function step(id: string, chainId: number, extra: Record<string, unknown> = {}): RelayStep {
  return { id, kind: "transaction", items: [{ data: { to: TO, value: "1000", data: "0xabcd", chainId, ...extra } }] } as unknown as RelayStep;
}

// ── planRelayStepTx — fail-closed, ORIGIN-ONLY per-step extraction (B3) ──
describe("planRelayStepTx — origin-only, fail-closed", () => {
  it("a valid origin-chain step canonicalizes to { to, data, value }", () => {
    const tx = planRelayStepTx(step("deposit", ORIGIN), ORIGIN, FROM, NATIVE_IN);
    expect(tx).toEqual({ to: getAddress(TO), data: "0xabcd", value: 1000n });
  });

  it("a DESTINATION-chain step is REJECTED (origin-only — the pre-B3 leniency is gone)", () => {
    expect(() => planRelayStepTx(step("deposit", DESTINATION), ORIGIN, FROM, NATIVE_IN)).toThrow(/RELAY_STEP_CHAIN_MISMATCH|origin/i);
  });

  it("a non-transaction (signature) step is rejected", () => {
    const sig = { id: "permit", kind: "signature", items: [{}] } as unknown as RelayStep;
    expect(() => planRelayStepTx(sig, ORIGIN, FROM, NATIVE_IN)).toThrow(/RELAY_UNSUPPORTED_STEP|signable/i);
  });

  it("a step with MORE than one tx item is rejected (unexpected shape, never guess)", () => {
    const multi = { id: "deposit", kind: "transaction", items: [{ data: { to: TO, value: "1", data: "0x", chainId: ORIGIN } }, { data: { to: TO, value: "2", data: "0x", chainId: ORIGIN } }] } as unknown as RelayStep;
    expect(() => planRelayStepTx(multi, ORIGIN, FROM, NATIVE_IN)).toThrow();
  });

  it("a step with NO tx item is rejected", () => {
    const none = { id: "deposit", kind: "transaction", items: [{}] } as unknown as RelayStep;
    expect(() => planRelayStepTx(none, ORIGIN, FROM, NATIVE_IN)).toThrow();
  });

  it("a sender that does not match the selected wallet is rejected", () => {
    expect(() => planRelayStepTx(step("deposit", ORIGIN, { from: "0x9999999999999999999999999999999999999999" }), ORIGIN, FROM, NATIVE_IN))
      .toThrow(/sender/i);
  });

  it("a malformed recipient/value is rejected pre-broadcast", () => {
    const badTo = { id: "deposit", kind: "transaction", items: [{ data: { to: "0xNOTANADDRESS", value: "1", data: "0x", chainId: ORIGIN } }] } as unknown as RelayStep;
    expect(() => planRelayStepTx(badTo, ORIGIN, FROM, NATIVE_IN)).toThrow(/recipient/i);
    const badValue = { id: "deposit", kind: "transaction", items: [{ data: { to: TO, value: "not-a-number", data: "0x", chainId: ORIGIN } }] } as unknown as RelayStep;
    expect(() => planRelayStepTx(badValue, ORIGIN, FROM, NATIVE_IN)).toThrow(/value/i);
  });
});

describe("parseRequestIdFromCheckEndpoint", () => {
  const BASE = "https://api.relay.link";

  it("extracts requestId from an absolute status URL on the Relay host + exact path", () => {
    expect(parseRequestIdFromCheckEndpoint("https://api.relay.link/intents/status/v3?requestId=0xABC", BASE)).toBe("0xABC");
  });
  it("extracts requestId from a relative status URL (resolved against the Relay host)", () => {
    expect(parseRequestIdFromCheckEndpoint("/intents/status/v3?requestId=0xDEF&foo=bar", BASE)).toBe("0xDEF");
  });
  it("returns null for an absolute URL on the WRONG host (even with the right path + requestId)", () => {
    expect(parseRequestIdFromCheckEndpoint("https://evil.example.com/intents/status/v3?requestId=0xABC", BASE)).toBeNull();
  });
  it("returns null for the right host but the WRONG path", () => {
    expect(parseRequestIdFromCheckEndpoint("https://api.relay.link/some/other/path?requestId=0xABC", BASE)).toBeNull();
  });
  it("returns null for a relative URL with the WRONG path", () => {
    expect(parseRequestIdFromCheckEndpoint("/intents/status/v2?requestId=0xABC", BASE)).toBeNull();
  });
  it("returns null for the right host + path but an EMPTY requestId", () => {
    expect(parseRequestIdFromCheckEndpoint("https://api.relay.link/intents/status/v3?requestId=", BASE)).toBeNull();
  });
  it("returns null when the requestId param is absent", () => {
    expect(parseRequestIdFromCheckEndpoint("https://api.relay.link/intents/status/v3", BASE)).toBeNull();
  });
  it("returns null for a malformed endpoint", () => {
    expect(parseRequestIdFromCheckEndpoint("::::not a url::::", BASE)).toBeNull();
  });
});

// ── pollRelayIntentStatus — bounded, informational in-turn poll (1s cadence) ──
describe("pollRelayIntentStatus — bounded 1s-cadence poll", () => {
  beforeEach(() => {
    getIntentStatus.mockReset();
  });

  it("polls at a 1s cadence and returns the terminal status + destination hashes", async () => {
    vi.useFakeTimers();
    try {
      getIntentStatus
        .mockResolvedValueOnce({ status: "waiting" })
        .mockResolvedValueOnce({ status: "success", txHashes: ["0xfill"] });
      const promise = pollRelayIntentStatus("0xreq");
      await vi.advanceTimersByTimeAsync(1_000); // first poll → waiting
      expect(getIntentStatus).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000); // second poll → success (terminal)
      const result = await promise;
      expect(result.status).toBe("success");
      expect(result.observed).toBe(true);
      expect(result.destinationTxHashes).toEqual(["0xfill"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns the last OBSERVED non-terminal status when the 10s budget is exhausted", async () => {
    vi.useFakeTimers();
    try {
      getIntentStatus.mockResolvedValue({ status: "submitted" }); // never terminal
      const promise = pollRelayIntentStatus("0xreq");
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(result.status).toBe("submitted");
      expect(result.observed).toBe(true);
      expect(getIntentStatus.mock.calls.length).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports observed:false when EVERY poll throws (status API unreachable, not benign pending)", async () => {
    vi.useFakeTimers();
    try {
      getIntentStatus.mockRejectedValue(new Error("status API down"));
      const promise = pollRelayIntentStatus("0xreq");
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await promise;
      expect(result.observed).toBe(false);
      expect(result.destinationTxHashes).toEqual([]);
      expect(getIntentStatus.mock.calls.length).toBe(10);
    } finally {
      vi.useRealTimers();
    }
  });
});
