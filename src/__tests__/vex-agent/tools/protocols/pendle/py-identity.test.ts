/**
 * Pendle PY identity divergence + record↔gate agreement (P4).
 *
 * The `mint` and `redeem_py` identities bind the FULL execute-variance surface,
 * not just the asset legs (Codex doctrine). A changed tokenIn / outputToken /
 * slippage / chainId MUST produce a different match-hash (→ the gate BLOCKS a
 * divergent execute), while the SAME params on both the record and gate sides
 * (which call the SAME builder) MUST collide — including on a non-Ethereum chain.
 *
 * The market lookup + wallet resolution are mocked so the builders are
 * network-free here; `resolvePendleChainId` is the real network-free registry.
 */

import { describe, it, expect, vi } from "vitest";

const MARKET = {
  address: "0x34280882267ffa6383b363e278b027be083bbe3b",
  yt: "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95",
  sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
  underlyingAsset: "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0",
  pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
  expiry: "2027-12-30T00:00:00.000Z",
};

// The market lookup is chain-scoped but the identity binds the chainId explicitly,
// so returning the same market for every chain still exercises chain divergence.
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByPt: vi.fn(async () => MARKET),
}));

const WALLET = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
}));

const { buildPendleMintIdentity, buildPendleRedeemPyIdentity } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/pendle-py.js"
);
const { computePrequoteMatchHash } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/hash.js"
);
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import { VEX_DEFAULT_SLIPPAGE_BPS } from "@vex-agent/tools/protocols/slippage-policy.js";

const CTX = {} as unknown as ProtocolExecutionContext;
const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const WSTETH = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const mintParams = (over: Record<string, unknown> = {}) => ({ chain: "ethereum", pt: PT, tokenIn: WSTETH, amountIn: "1", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS, ...over });
const redeemParams = (over: Record<string, unknown> = {}) => ({ chain: "ethereum", pt: PT, tokenOut: WSTETH, amountIn: "1", slippageBps: VEX_DEFAULT_SLIPPAGE_BPS, ...over });

async function mintHash(over: Record<string, unknown> = {}): Promise<string> {
  return computePrequoteMatchHash(await buildPendleMintIdentity("sess-1", mintParams(over), CTX));
}
async function redeemHash(over: Record<string, unknown> = {}): Promise<string> {
  return computePrequoteMatchHash(await buildPendleRedeemPyIdentity("sess-1", redeemParams(over), CTX));
}

describe("pendle PY mint identity", () => {
  it("record↔gate agree for identical params (same builder both sides)", async () => {
    expect(await mintHash()).toBe(await mintHash());
  });

  it("agree on a non-Ethereum chain (arbitrum), distinct from Ethereum", async () => {
    const arb = await mintHash({ chain: "arbitrum" });
    expect(arb).toBe(await mintHash({ chain: "arbitrum" }));
    expect(arb).not.toBe(await mintHash({ chain: "ethereum" }));
  });

  it("changed slippage ⇒ different hash", async () => {
    expect(await mintHash({ slippageBps: VEX_DEFAULT_SLIPPAGE_BPS })).not.toBe(await mintHash({ slippageBps: 300 }));
  });

  it("changed tokenIn ⇒ different hash", async () => {
    expect(await mintHash({ tokenIn: WSTETH })).not.toBe(await mintHash({ tokenIn: USDC }));
  });

  it("changed chainId ⇒ different hash", async () => {
    expect(await mintHash({ chain: "ethereum" })).not.toBe(await mintHash({ chain: "base" }));
  });

  it("omitted slippage normalizes to the default on both sides", async () => {
    const withDefault = await mintHash({ slippageBps: undefined });
    expect(withDefault).toBe(await mintHash({ slippageBps: VEX_DEFAULT_SLIPPAGE_BPS }));
  });
});

describe("pendle PY pre-expiry redeem identity", () => {
  it("record↔gate agree for identical params", async () => {
    expect(await redeemHash()).toBe(await redeemHash());
  });

  it("agree on a non-Ethereum chain (arbitrum), distinct from Ethereum", async () => {
    const arb = await redeemHash({ chain: "arbitrum" });
    expect(arb).toBe(await redeemHash({ chain: "arbitrum" }));
    expect(arb).not.toBe(await redeemHash({ chain: "ethereum" }));
  });

  it("changed slippage ⇒ different hash", async () => {
    expect(await redeemHash({ slippageBps: VEX_DEFAULT_SLIPPAGE_BPS })).not.toBe(await redeemHash({ slippageBps: 300 }));
  });

  it("changed outputToken ⇒ different hash", async () => {
    expect(await redeemHash({ tokenOut: WSTETH })).not.toBe(await redeemHash({ tokenOut: USDC }));
  });

  it("omitted tokenOut defaults to the market underlying and matches it explicitly", async () => {
    // Omitting tokenOut → the market's underlyingAsset (== WSTETH here), so it
    // collides with an explicit tokenOut of WSTETH.
    expect(await redeemHash({ tokenOut: undefined })).toBe(await redeemHash({ tokenOut: WSTETH }));
  });

  it("changed chainId ⇒ different hash", async () => {
    expect(await redeemHash({ chain: "ethereum" })).not.toBe(await redeemHash({ chain: "base" }));
  });
});

describe("pendle PY cross-kind isolation", () => {
  it("a mint identity and a redeem_py identity never collide for the same values", async () => {
    expect(await mintHash()).not.toBe(await redeemHash());
  });
});
