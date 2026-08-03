/**
 * Slippage in the prequote identity — canonicalization and Relay binding.
 *
 * Two defects, one property: a quote must never authorize an execute that
 * applies a DIFFERENT slippage.
 *
 *  - `canonSlippageBps` truncated with `Math.trunc`, so `0.5` and `0.9` both
 *    canonicalized to `"0"`: the digests collided and the gate passed a pair
 *    whose applied tolerance differed by 40 bps.
 *  - The Relay bridge identity bound chains, tokens, amount, recipient,
 *    refundTo and tradeType — but NOT `slippageBps`, even though
 *    `relay.bridge` forwards it to Relay as `slippageTolerance`. A 50 bps
 *    `relay.quote.get` and a 5000 bps `relay.bridge` produced the SAME hash.
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

import {
  canonSlippageBps,
  canonSlippageBpsWithDefault,
} from "@vex-agent/tools/protocols/prequote/slippage.js";
import { buildRelayBridgeIdentity } from "@vex-agent/tools/protocols/prequote/identity/relay-bridge.js";
import { computePrequoteMatchHash } from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import { VexError } from "../../../../../errors.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

describe("canonSlippageBps — no silent coercion into hash material", () => {
  it("0.5 and 0.9 no longer collide — both are refused instead of becoming \"0\"", () => {
    expect(() => canonSlippageBps(0.5)).toThrow(VexError);
    expect(() => canonSlippageBps(0.9)).toThrow(VexError);
  });

  it("a whole value canonicalizes to its integer string", () => {
    expect(canonSlippageBps(50)).toBe("50");
    expect(canonSlippageBps(0)).toBe("0");
    expect(canonSlippageBps(5000)).toBe("5000");
  });

  it("omitted collapses to the stable sentinel on both sides", () => {
    expect(canonSlippageBps(null)).toBe("");
    expect(canonSlippageBps(undefined)).toBe("");
  });

  it("distinct whole values never share a digest input", () => {
    expect(canonSlippageBps(50)).not.toBe(canonSlippageBps(5000));
  });

  it("refuses negative and non-finite values rather than folding them in", () => {
    expect(() => canonSlippageBps(-1)).toThrow(VexError);
    expect(() => canonSlippageBps(Number.NaN)).toThrow(VexError);
    expect(() => canonSlippageBps(Number.POSITIVE_INFINITY)).toThrow(VexError);
  });
});

describe("canonSlippageBpsWithDefault — the Pendle identities' shared normalizer", () => {
  it("an absent value takes the handler default so quote↔execute still collide", () => {
    expect(canonSlippageBpsWithDefault({}, 50)).toBe("50");
    expect(canonSlippageBpsWithDefault({ slippageBps: undefined }, 50)).toBe("50");
  });

  it("a present value is bound verbatim, never replaced by the default", () => {
    expect(canonSlippageBpsWithDefault({ slippageBps: 300 }, 50)).toBe("300");
  });

  it("a fractional value is refused, not floored to a colliding digest", () => {
    expect(() => canonSlippageBpsWithDefault({ slippageBps: 0.5 }, 50)).toThrow(VexError);
    expect(() => canonSlippageBpsWithDefault({ slippageBps: 0.9 }, 50)).toThrow(VexError);
  });

  it("a wrong-typed value is refused, not silently defaulted", () => {
    // Previously `slippageBps: "9999"` fell back to the default and hashed
    // identically to an omitted slippage.
    expect(() => canonSlippageBpsWithDefault({ slippageBps: "9999" }, 50)).toThrow(VexError);
  });
});

describe("relay bridge identity — slippageBps is bound", () => {
  const ctx = {} as unknown as ProtocolExecutionContext;
  const params = (slippageBps?: number) => ({
    fromChain: "8453",
    toChain: "4663",
    fromToken: "eth",
    toToken: "eth",
    amountRaw: "1000",
    ...(slippageBps !== undefined ? { slippageBps } : {}),
  });

  const hashFor = async (slippageBps?: number) =>
    computePrequoteMatchHash(await buildRelayBridgeIdentity("s1", params(slippageBps), ctx));

  it("a 50 bps quote no longer authorizes a 500 bps execute", async () => {
    expect(await hashFor(50)).not.toBe(await hashFor(500));
  });

  it("the identity carries the canonical integer string", async () => {
    const identity = await buildRelayBridgeIdentity("s1", params(50), ctx);
    expect(identity.slippageBps).toBe("50");
  });

  // W4a: an omitted slippage is no longer a `""` sentinel — the handler sends
  // the Vex default explicitly, so the identity binds that same number.
  it("an omitted slippage binds the materialized default — quote↔execute still collide", async () => {
    const identity = await buildRelayBridgeIdentity("s1", params(), ctx);
    expect(identity.slippageBps).toBe(String(VEX_DEFAULT_SLIPPAGE_BPS));
    expect(await hashFor()).toBe(await hashFor());
  });

  it("an omitted slippage does NOT authorize a DIFFERENT explicit one", async () => {
    expect(await hashFor()).not.toBe(await hashFor(VEX_DEFAULT_SLIPPAGE_BPS + 50));
  });

  it("the same slippage on both sides still collides", async () => {
    expect(await hashFor(100)).toBe(await hashFor(100));
  });

  it("refuses an over-ceiling slippage — the identity can never bind 5000 bps", async () => {
    await expect(buildRelayBridgeIdentity("s1", params(5000), ctx)).rejects.toThrow(VexError);
  });

  it("refuses a non-integer or wrong-typed slippage rather than coercing it", async () => {
    await expect(buildRelayBridgeIdentity("s1", params(0.5), ctx)).rejects.toThrow(VexError);
    await expect(buildRelayBridgeIdentity("s1", params(-50), ctx)).rejects.toThrow(VexError);
    await expect(
      buildRelayBridgeIdentity("s1", { ...params(), slippageBps: "50" }, ctx),
    ).rejects.toThrow(VexError);
  });

  it("accepts the ceiling itself", async () => {
    const identity = await buildRelayBridgeIdentity("s1", params(1000), ctx);
    expect(identity.slippageBps).toBe("1000");
  });
});
