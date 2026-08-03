/**
 * W4b — the slippage default has ONE home, and it is 100 bps.
 *
 * Two properties, both money-path:
 *
 *  1. EVERY venue that resolves an omitted `slippageBps` resolves it to the
 *     SAME number. Nine per-venue copies used to decide this independently;
 *     six of them fed prequote hash material, so a drift between any two
 *     silently split a quote from the execute it was supposed to authorize.
 *  2. At the new default, an omitted-slippage quote round-trips with an
 *     omitted-slippage execute AND with an explicit `100` — and no longer with
 *     the old `50`. A prequote recorded before the flip therefore fails its
 *     gate CLOSED (≤15 min window); a re-quote resolves it. Failing closed is
 *     the safe direction: the execute is refused, never admitted under a
 *     tolerance nobody authorized.
 */

import { describe, it, expect, vi } from "vitest";

// Mocked so the Relay identity builder resolves chains + wallet without
// network or vault access (same seam as `prequote/slippage-binding.test.ts`).
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
  VEX_DEFAULT_SLIPPAGE_BPS,
  resolveRelaySlippageBps,
} from "@vex-agent/tools/protocols/slippage-policy.js";
import { resolveKyberSlippageBps } from "@vex-agent/tools/protocols/kyberswap/handlers/swap/slippage.js";
import { resolveUniswapSlippageBps } from "@vex-agent/tools/protocols/uniswap/handlers/swap/slippage.js";
import { resolveJupiterSwapKnobs } from "@vex-agent/tools/protocols/solana-jupiter/handlers/core/swap-policy.js";
import { resolvePendleSlippage } from "@vex-agent/tools/protocols/pendle/handlers/shared.js";
import { resolveTradeInputs } from "@vex-agent/tools/protocols/trench/handlers/trade/shared.js";
import { canonSlippageBpsWithDefault } from "@vex-agent/tools/protocols/prequote/slippage.js";
import { buildRelayBridgeIdentity } from "@vex-agent/tools/protocols/prequote/identity/relay-bridge.js";
import { computePrequoteMatchHash } from "@vex-agent/tools/protocols/prequote/identity/hash.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const OLD_DEFAULT_BPS = 50;

describe("VEX_DEFAULT_SLIPPAGE_BPS — the single home", () => {
  it("is 100 bps (1%) — owner decree 2026-08-03, W4b", () => {
    expect(VEX_DEFAULT_SLIPPAGE_BPS).toBe(100);
  });
});

describe("an omitted slippageBps resolves to the ONE default on every venue", () => {
  it("kyberswap", () => {
    expect(resolveKyberSlippageBps("kyberswap.swap.quote", {})).toEqual({
      ok: true,
      bps: VEX_DEFAULT_SLIPPAGE_BPS,
    });
  });

  it("uniswap", () => {
    expect(resolveUniswapSlippageBps("uniswap.swap.quote", {})).toEqual({
      ok: true,
      bps: VEX_DEFAULT_SLIPPAGE_BPS,
    });
  });

  it("solana / jupiter", () => {
    expect(resolveJupiterSwapKnobs({}).slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("relay", () => {
    expect(resolveRelaySlippageBps('Parameter "slippageBps"', undefined)).toEqual({
      ok: true,
      bps: VEX_DEFAULT_SLIPPAGE_BPS,
    });
  });

  it("pendle", () => {
    expect(resolvePendleSlippage("pendle.pt.buy", undefined).bps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("trench express", () => {
    const resolved = resolveTradeInputs({
      chain: "robinhood",
      tokenIn: "ETH",
      tokenOut: "0x58659Ef9Be57216632BFD341FC57736a429EFB91",
      amountIn: "0.01",
    });
    expect(resolved.ok).toBe(true);
    if (resolved.ok) expect(resolved.value.slippageBps).toBe(VEX_DEFAULT_SLIPPAGE_BPS);
  });

  it("an explicitly supplied value is never replaced by the default", () => {
    expect(resolveKyberSlippageBps("kyberswap.swap.quote", { slippageBps: 25 })).toEqual({ ok: true, bps: 25 });
    expect(resolveUniswapSlippageBps("uniswap.swap.quote", { slippageBps: 25 })).toEqual({ ok: true, bps: 25 });
    expect(resolvePendleSlippage("pendle.pt.buy", 25).bps).toBe(25);
  });
});

describe("prequote round-trip at the new default", () => {
  it("hash material: omitted ≡ explicit 100, and no longer ≡ the old 50", () => {
    const omitted = canonSlippageBpsWithDefault({}, VEX_DEFAULT_SLIPPAGE_BPS);
    expect(omitted).toBe(canonSlippageBpsWithDefault({ slippageBps: 100 }, VEX_DEFAULT_SLIPPAGE_BPS));
    expect(omitted).not.toBe(
      canonSlippageBpsWithDefault({ slippageBps: OLD_DEFAULT_BPS }, VEX_DEFAULT_SLIPPAGE_BPS),
    );
  });

  it("relay identity: an omitted-slippage quote authorizes an explicit-100 execute, not an explicit-50 one", async () => {
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

    expect(await hashFor()).toBe(await hashFor(VEX_DEFAULT_SLIPPAGE_BPS));
    // A prequote recorded BEFORE the flip (50 bps materialized) fails closed.
    expect(await hashFor()).not.toBe(await hashFor(OLD_DEFAULT_BPS));
  });
});
