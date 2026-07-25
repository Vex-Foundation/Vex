/**
 * Relay bridge trade-type identity distinctness (Wave-2 W2, R10).
 *
 * `EXPECTED_OUTPUT` must be a DISTINCT identity value, not collapsed to
 * `EXACT_INPUT`. Two layers:
 *  A. hash-level — `computePrequoteMatchHash` over identities differing ONLY in
 *     tradeType yields three distinct digests (and is deterministic).
 *  B. build-level — `buildRelayBridgeIdentity` (used at BOTH record- and
 *     gate-time) surfaces `EXPECTED_OUTPUT` through `parseTradeType`, so an
 *     `EXPECTED_OUTPUT` quote↔execute hashes differently from `EXACT_INPUT`,
 *     while an absent tradeType still defaults to `EXACT_INPUT`.
 */

import { describe, it, expect, vi } from "vitest";

// Mocked so the identity builder resolves chains + wallet without network/vault.
vi.mock("@tools/relay/client.js", () => ({
  getCachedRelayChains: async () => [
    { id: 8453, name: "base" },
    { id: 4663, name: "robinhood" },
  ],
}));
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => "0x1111111111111111111111111111111111111111",
}));

import { buildRelayBridgeIdentity } from "@vex-agent/tools/protocols/prequote/identity/relay-bridge.js";
import {
  computePrequoteMatchHash,
  type BridgeMatchInput,
  type BridgeTradeType,
} from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const baseIdentity: BridgeMatchInput = {
  kind: "bridge",
  sessionId: "s1",
  provider: "relay",
  sourceFamily: "eip155",
  destFamily: "eip155",
  fromChainId: 8453,
  toChainId: 4663,
  sourceWallet: "0x1111111111111111111111111111111111111111",
  recipient: "0x1111111111111111111111111111111111111111",
  fromToken: "0x0000000000000000000000000000000000000000",
  toToken: "0x0000000000000000000000000000000000000000",
  amount: "1000",
  tradeType: "EXACT_INPUT",
  refundTo: "0x1111111111111111111111111111111111111111",
  referrer: "",
  referrerFeeBps: "",
  filler: "",
  // Bound since the relay slippage fix — "" is the omitted-slippage sentinel.
  slippageBps: "",
};

const hashOf = (tradeType: BridgeTradeType) => computePrequoteMatchHash({ ...baseIdentity, tradeType });

describe("A. hash-level distinctness", () => {
  it("EXACT_INPUT / EXACT_OUTPUT / EXPECTED_OUTPUT all hash to distinct digests", () => {
    const digests = new Set([hashOf("EXACT_INPUT"), hashOf("EXACT_OUTPUT"), hashOf("EXPECTED_OUTPUT")]);
    expect(digests.size).toBe(3);
  });

  it("EXPECTED_OUTPUT is not collapsed onto EXACT_INPUT", () => {
    expect(hashOf("EXPECTED_OUTPUT")).not.toBe(hashOf("EXACT_INPUT"));
  });

  it("is deterministic (same identity → same digest)", () => {
    expect(hashOf("EXPECTED_OUTPUT")).toBe(hashOf("EXPECTED_OUTPUT"));
  });
});

describe("B. build-level (parseTradeType through the shared builder)", () => {
  const ctx = {} as unknown as ProtocolExecutionContext;
  const params = (tradeType?: string) => ({
    fromChain: "8453",
    toChain: "4663",
    fromToken: "eth",
    toToken: "eth",
    amount: "1000",
    ...(tradeType !== undefined ? { tradeType } : {}),
  });

  it("an EXPECTED_OUTPUT param surfaces as a distinct identity value", async () => {
    const identity = await buildRelayBridgeIdentity("s1", params("EXPECTED_OUTPUT"), ctx);
    expect(identity.tradeType).toBe("EXPECTED_OUTPUT");
  });

  it("EXPECTED_OUTPUT vs EXACT_INPUT params hash differently through the full path", async () => {
    const expected = await buildRelayBridgeIdentity("s1", params("EXPECTED_OUTPUT"), ctx);
    const exact = await buildRelayBridgeIdentity("s1", params("EXACT_INPUT"), ctx);
    expect(computePrequoteMatchHash(expected)).not.toBe(computePrequoteMatchHash(exact));
  });

  it("an absent tradeType still defaults to EXACT_INPUT (unchanged default)", async () => {
    const absent = await buildRelayBridgeIdentity("s1", params(), ctx);
    const exact = await buildRelayBridgeIdentity("s1", params("EXACT_INPUT"), ctx);
    expect(absent.tradeType).toBe("EXACT_INPUT");
    expect(computePrequoteMatchHash(absent)).toBe(computePrequoteMatchHash(exact));
  });
});
