/**
 * Pendle LP identity divergence + record↔gate agreement + cross-kind isolation
 * (P5).
 *
 * The `lp_add` and `lp_remove` identities bind the FULL execute-variance surface:
 * a changed market / tokenIn / tokenOut / slippage / chainId MUST produce a
 * different match-hash (→ the gate BLOCKS a divergent execute), while the SAME
 * params on both the record and gate sides (which call the SAME builder) MUST
 * collide — including on a non-Ethereum chain. Direction is structurally
 * unmixable: an `lp_add` hash can never equal an `lp_remove` hash, and neither can
 * equal a swap / mint / redeem_py hash (distinct `kind` discriminant).
 *
 * The market lookup + wallet resolution are mocked so the builders are
 * network-free here; `resolvePendleChainId` is the real network-free registry. The
 * mock ECHOES the requested market address so a changed `market` param changes the
 * bound market (and therefore the hash).
 */

import { describe, it, expect, vi } from "vitest";

const UNDERLYING = "0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0";

vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  resolveMarketByAddress: vi.fn(async (_chainId: number, addr: string) => ({
    address: addr,
    yt: "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95",
    sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
    underlyingAsset: UNDERLYING,
    pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
    expiry: "2027-12-30T00:00:00.000Z",
  })),
}));

// R5b: the exit actions (pt.redeem, lp.remove, claim) resolve through the
// matured-capable lane. Delegates to the SAME market doubles this suite
// already sets up, wrapped in the {market, maturity} envelope.
vi.mock("@vex-agent/tools/protocols/pendle/matured-market-lookup.js", () => ({
  resolveExitMarketByAddress: vi.fn(async (_chainId: number, addr: string) => ({
    market: {
        address: addr,
        yt: "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95",
        sy: "0xcbc72d92b2dc8187414f6734718563898740c0bc",
        underlyingAsset: UNDERLYING,
        pt: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
        expiry: "2027-12-30T00:00:00.000Z",
      },
    maturity: "active",
  })),
}));

const WALLET = "0x742d35cc6634c0532925a3b844bc454e4438f44e";
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: vi.fn(() => WALLET),
}));

const { buildPendleLpAddIdentity, buildPendleLpRemoveIdentity } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/pendle-lp.js"
);
const { computePrequoteMatchHash } = await import(
  "../../../../../vex-agent/tools/protocols/prequote/identity/hash.js"
);
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const CTX = {} as unknown as ProtocolExecutionContext;
const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const MARKET2 = "0xba1cbaece600beec76dabc0a4ead31e0339cbe37";
const WSTETH = UNDERLYING;
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

const addParams = (over: Record<string, unknown> = {}) => ({ chain: "ethereum", market: MARKET, tokenIn: WSTETH, amountIn: "1", slippageBps: 50, ...over });
const removeParams = (over: Record<string, unknown> = {}) => ({ chain: "ethereum", market: MARKET, tokenOut: WSTETH, amountIn: "1", slippageBps: 50, ...over });

async function addHash(over: Record<string, unknown> = {}): Promise<string> {
  return computePrequoteMatchHash(await buildPendleLpAddIdentity("sess-1", addParams(over), CTX));
}
async function removeHash(over: Record<string, unknown> = {}): Promise<string> {
  return computePrequoteMatchHash(await buildPendleLpRemoveIdentity("sess-1", removeParams(over), CTX));
}

describe("pendle LP add identity", () => {
  it("record↔gate agree for identical params (same builder both sides)", async () => {
    expect(await addHash()).toBe(await addHash());
  });

  it("agree on a non-Ethereum chain (arbitrum), distinct from Ethereum", async () => {
    const arb = await addHash({ chain: "arbitrum" });
    expect(arb).toBe(await addHash({ chain: "arbitrum" }));
    expect(arb).not.toBe(await addHash({ chain: "ethereum" }));
  });

  it("changed slippage ⇒ different hash", async () => {
    expect(await addHash({ slippageBps: 50 })).not.toBe(await addHash({ slippageBps: 100 }));
  });

  it("changed tokenIn ⇒ different hash", async () => {
    expect(await addHash({ tokenIn: WSTETH })).not.toBe(await addHash({ tokenIn: USDC }));
  });

  it("changed market ⇒ different hash", async () => {
    expect(await addHash({ market: MARKET })).not.toBe(await addHash({ market: MARKET2 }));
  });

  it("changed chainId ⇒ different hash", async () => {
    expect(await addHash({ chain: "ethereum" })).not.toBe(await addHash({ chain: "base" }));
  });

  it("omitted slippage normalizes to the default (50) on both sides", async () => {
    expect(await addHash({ slippageBps: undefined })).toBe(await addHash({ slippageBps: 50 }));
  });
});

describe("pendle LP remove identity", () => {
  it("record↔gate agree for identical params", async () => {
    expect(await removeHash()).toBe(await removeHash());
  });

  it("agree on a non-Ethereum chain (arbitrum), distinct from Ethereum", async () => {
    const arb = await removeHash({ chain: "arbitrum" });
    expect(arb).toBe(await removeHash({ chain: "arbitrum" }));
    expect(arb).not.toBe(await removeHash({ chain: "ethereum" }));
  });

  it("changed slippage ⇒ different hash", async () => {
    expect(await removeHash({ slippageBps: 50 })).not.toBe(await removeHash({ slippageBps: 100 }));
  });

  it("changed tokenOut ⇒ different hash", async () => {
    expect(await removeHash({ tokenOut: WSTETH })).not.toBe(await removeHash({ tokenOut: USDC }));
  });

  it("changed market ⇒ different hash", async () => {
    expect(await removeHash({ market: MARKET })).not.toBe(await removeHash({ market: MARKET2 }));
  });

  it("omitted tokenOut defaults to the market underlying and matches it explicitly", async () => {
    expect(await removeHash({ tokenOut: undefined })).toBe(await removeHash({ tokenOut: WSTETH }));
  });

  it("changed chainId ⇒ different hash", async () => {
    expect(await removeHash({ chain: "ethereum" })).not.toBe(await removeHash({ chain: "base" }));
  });
});

describe("pendle LP cross-kind isolation", () => {
  it("an lp_add identity and an lp_remove identity never collide for the same market/amount", async () => {
    // Same market + amount + slippage on both; only the direction (kind) differs.
    expect(await addHash({ tokenIn: WSTETH })).not.toBe(await removeHash({ tokenOut: WSTETH }));
  });

  it("an lp_add hash can never equal a swap / mint / redeem_py hash (distinct kind tag)", async () => {
    const add = await addHash();
    const swap = computePrequoteMatchHash({
      kind: "swap", sessionId: "sess-1", family: "eip155", provider: "pendle",
      chainId: 1, walletAddress: WALLET, tokenIn: WSTETH, tokenOut: MARKET, amount: "1",
      recipient: WALLET, approveExact: false, slippageBps: "50",
    });
    const mint = computePrequoteMatchHash({
      kind: "mint", sessionId: "sess-1", provider: "pendle", chainId: 1, walletAddress: WALLET,
      receiver: WALLET, tokenIn: WSTETH, amount: "1", ptAddress: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
      ytAddress: "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95", market: MARKET, slippageBps: "50",
    });
    expect(add).not.toBe(swap);
    expect(add).not.toBe(mint);
  });

  it("an lp_remove hash can never equal a redeem_py hash (distinct kind tag)", async () => {
    const remove = await removeHash();
    const redeemPy = computePrequoteMatchHash({
      kind: "redeem_py", sessionId: "sess-1", provider: "pendle", chainId: 1, walletAddress: WALLET,
      receiver: WALLET, ptAddress: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
      ytAddress: "0x04b7fa1e727d7290d6e24fa9b426d0c940283a95", amount: "1", outputToken: WSTETH, slippageBps: "50",
    });
    expect(remove).not.toBe(redeemPy);
  });
});
