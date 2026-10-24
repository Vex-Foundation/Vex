/**
 * The Watchlist's token search: one entry per token, busiest first, matching
 * tokens only, and the public search answering when the chain search cannot.
 */
import { describe, expect, it, vi } from "vitest";
import {
  searchAlertTokens,
  tokensFromPairs,
  type CandidatePair,
  type TokenSearchDeps,
} from "../../../vex-agent/alerts/token-search.js";
import type { DexPair, SearchResponse } from "../../../tools/dexscreener/types.js";
import type { DexScreenerTransport } from "../../../tools/dexscreener/transport.js";
import { requireValue } from "../../helpers/require-value.js";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const COPYCAT = "9tPeuW6hAw6YuKtYGCAaw7MZ9YBvJxyRCGXtvXUu6Pfn";
const SOL = "So11111111111111111111111111111111111111112";

function pair(over: Partial<CandidatePair> & { base: CandidatePair["base"] }): CandidatePair {
  return {
    chainId: "solana",
    dexId: "raydium",
    pairAddress: `pair-${Math.random()}`,
    priceUsd: "0.00002",
    liquidityUsd: 100_000,
    volume24hUsd: 50_000,
    quote: { address: SOL, symbol: "SOL", name: "Wrapped SOL" },
    ...over,
  };
}

describe("tokensFromPairs", () => {
  it("ranks by summed 24h volume, so a copycat with inflated liquidity sinks", () => {
    const hits = tokensFromPairs(
      [
        pair({ base: { address: COPYCAT, symbol: "Bonk", name: "Bonk Coin" }, liquidityUsd: 50_394_585, volume24hUsd: 2 }),
        pair({ base: { address: BONK, symbol: "Bonk", name: "Bonk" }, liquidityUsd: 305_845, volume24hUsd: 400_000, dexId: "orca" }),
        pair({ base: { address: BONK, symbol: "Bonk", name: "Bonk" }, liquidityUsd: 263_064, volume24hUsd: 297_892, dexId: "meteora" }),
      ],
      "BONK",
      "solana",
    );
    expect(hits.map((hit) => hit.address)).toEqual([BONK, COPYCAT]);
    const bonk = requireValue(hits[0]);
    expect(bonk.poolCount).toBe(2);
    expect(bonk.volume24hUsd).toBe(697_892);
    expect(bonk.liquidityUsd).toBe(568_909);
    // The busiest pool speaks for it.
    expect(bonk.dexId).toBe("orca");
  });

  it("keeps only tokens that match, on the chosen chain", () => {
    const hits = tokensFromPairs(
      [
        pair({ base: { address: BONK, symbol: "Bonk", name: "Bonk" } }),
        pair({ chainId: "base", base: { address: "0xbonk", symbol: "BONK", name: "Bonk on Base" } }),
      ],
      "bonk",
      "solana",
    );
    // SOL was the other side of the pool and does not match "bonk".
    expect(hits.map((hit) => hit.symbol)).toEqual(["Bonk"]);
  });

  it("gives a quote-side match no price of its own", () => {
    const hits = tokensFromPairs(
      [pair({ base: { address: BONK, symbol: "Bonk", name: "Bonk" } })],
      "wrapped sol",
      "solana",
    );
    expect(hits).toHaveLength(1);
    expect(requireValue(hits[0]).address).toBe(SOL);
    expect(requireValue(hits[0]).priceUsd).toBeNull();
  });

  it("matches an exact address", () => {
    const hits = tokensFromPairs([pair({ base: { address: BONK, symbol: "Bonk", name: "Bonk" } })], BONK, "solana");
    expect(requireValue(hits[0]).address).toBe(BONK);
  });
});

function publicPair(over: Partial<DexPair>): DexPair {
  return {
    chainId: "solana",
    dexId: "raydium",
    url: "https://dexscreener.com/solana/x",
    pairAddress: "pair-public",
    labels: null,
    baseToken: { address: BONK, name: "Bonk", symbol: "Bonk" },
    quoteToken: { address: SOL, name: "Wrapped SOL", symbol: "SOL" },
    priceNative: "0.0000001",
    priceUsd: "0.00002",
    txns: {},
    volume: { h24: 1234 },
    priceChange: null,
    liquidity: { usd: 99_000, base: 1, quote: 1 },
    fdv: null,
    marketCap: null,
    pairCreatedAt: null,
    info: null,
    boosts: null,
    ...over,
  } as DexPair;
}

/** Never called: the chain search is injected and throws before any request. */
const STUB_TRANSPORT: DexScreenerTransport = {
  capabilities: { site: true, publicApi: false },
  name: "site_bridge",
  httpGet: async () => {
    throw new Error("not used");
  },
  wsExchange: async () => {
    throw new Error("not used");
  },
};

function deps(over: Partial<TokenSearchDeps>): TokenSearchDeps {
  return {
    transport: () => STUB_TRANSPORT,
    chainSearch: vi.fn(async () => {
      throw new Error("bridge down");
    }),
    publicSearch: vi.fn(async (): Promise<SearchResponse> => ({ schemaVersion: "1.0.0", pairs: [publicPair({})] })),
    now: () => 0,
    ...over,
  };
}

describe("searchAlertTokens", () => {
  it("falls back to the public search, filtered to the chain, when the chain search is down", async () => {
    const injected = deps({});
    const result = await searchAlertTokens({ chain: "solana", query: "bonk" }, injected);
    expect(result).toMatchObject({ ok: true, chain: "solana", source: "public_search" });
    if (!result.ok) throw new Error("expected tokens");
    expect(result.tokens.map((hit) => hit.address)).toEqual([BONK]);
    expect(result.tokens[0]?.volume24hUsd).toBe(1234);
    expect(injected.publicSearch).toHaveBeenCalledWith("bonk", expect.objectContaining({ timeoutMs: 8_000 }));
  });

  it("answers search_unavailable when both sources fail", async () => {
    const result = await searchAlertTokens(
      { chain: "solana", query: "bonk" },
      deps({
        publicSearch: vi.fn(async () => {
          throw new Error("offline");
        }),
      }),
    );
    expect(result).toMatchObject({ ok: false, reason: "search_unavailable" });
  });

  it("refuses an unknown chain and a too-short or quoted query by name", async () => {
    const injected = deps({});
    expect(await searchAlertTokens({ chain: "no-such-chain", query: "bonk" }, injected)).toMatchObject({
      ok: false,
      reason: "unsupported_chain",
    });
    expect(await searchAlertTokens({ chain: "base", query: "b" }, injected)).toMatchObject({ ok: false, reason: "invalid_query" });
    expect(await searchAlertTokens({ chain: "base", query: '"pepe"' }, injected)).toMatchObject({
      ok: false,
      reason: "invalid_query",
    });
    expect(injected.publicSearch).not.toHaveBeenCalled();
  });
});
