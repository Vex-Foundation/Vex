import { describe, expect, it, vi } from "vitest";

import { priceTokens, quoteFromPools, SYMBOL_MAX_CHARS, type ReadPools } from "@vex-agent/alerts/price-source.js";
import type { DexPair } from "../../../tools/dexscreener/types.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fcd6edb6e08f4c3c32d4f71b54bda02913";

function pair(over: Partial<DexPair> = {}): DexPair {
  return {
    chainId: "base",
    dexId: "uniswap",
    url: "https://dexscreener.com/base/pool",
    pairAddress: "0xpool",
    labels: null,
    baseToken: { address: WETH, name: "Wrapped Ether", symbol: "WETH" },
    quoteToken: { address: USDC, name: "USD Coin", symbol: "USDC" },
    priceNative: "3500",
    priceUsd: "3500",
    txns: {},
    volume: {},
    priceChange: { h24: -2.5 },
    liquidity: { usd: 1_000_000, base: 100, quote: 350_000 },
    fdv: null,
    marketCap: null,
    pairCreatedAt: null,
    info: null,
    boosts: null,
    ...over,
  };
}

describe("quoteFromPools", () => {
  it("prices a base-side token with its 24 hour change and symbol", () => {
    const quote = quoteFromPools({ chain: "base", address: WETH }, [pair()]);
    expect(quote).toMatchObject({
      assetKey: `base:${WETH}`,
      priceUsd: "3500",
      change24hPct: -2.5,
      pairAddress: "0xpool",
      dexId: "uniswap",
      symbol: "WETH",
    });
  });

  it("drops the 24 hour change on a quote-side pool: it belongs to the other token", () => {
    const quote = quoteFromPools({ chain: "base", address: USDC }, [pair()]);
    expect(quote?.symbol).toBe("USDC");
    expect(quote?.priceUsd).toBe("1");
    expect(quote?.change24hPct).toBeNull();
  });

  it("returns null when no pool on the chain holds the token", () => {
    expect(quoteFromPools({ chain: "base", address: `0x${"9".repeat(40)}` }, [pair()])).toBeNull();
    expect(quoteFromPools({ chain: "ethereum", address: WETH }, [pair()])).toBeNull();
  });

  it("bounds the symbol and strips control characters", () => {
    const long = `\u0007${"X".repeat(60)}`;
    const quote = quoteFromPools({ chain: "base", address: WETH }, [
      pair({ baseToken: { address: WETH, name: "x", symbol: long } }),
    ]);
    expect(quote?.symbol).toBe("X".repeat(SYMBOL_MAX_CHARS));
  });
});

describe("priceTokens", () => {
  it("reads each distinct token once and reports failed reads instead of throwing", async () => {
    const readPools = vi.fn<ReadPools>(async (_chain, address) => {
      if (address === USDC) throw new Error("timeout");
      return [pair()];
    });
    const result = await priceTokens(
      [
        { chain: "base", address: WETH },
        { chain: "base", address: WETH },
        { chain: "base", address: USDC },
      ],
      { readPools },
    );
    expect(readPools).toHaveBeenCalledTimes(2);
    expect([...result.quotes.keys()]).toEqual([`base:${WETH}`]);
    expect(result.failed).toEqual([`base:${USDC}`]);
  });

  it("bounds every read with a timeout and passes the caller's signal", async () => {
    const readPools = vi.fn<ReadPools>(async () => []);
    const controller = new AbortController();
    await priceTokens([{ chain: "base", address: WETH }], { readPools, signal: controller.signal });
    expect(readPools).toHaveBeenCalledWith("base", WETH, { timeoutMs: 5_000, signal: controller.signal });
  });
});
