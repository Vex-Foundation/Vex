import { afterEach, describe, expect, it, vi } from "vitest";

import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import type { DexPair } from "@tools/dexscreener/types.js";
import { DEXSCREENER_HANDLERS } from "@vex-agent/tools/protocols/dexscreener/handlers.js";
import {
  assessCrossPoolPrices,
  toPairRows,
} from "@vex-agent/tools/protocols/dexscreener/pair-list/index.js";
import {
  reconcileTokenBatchAddresses,
} from "@vex-agent/tools/protocols/dexscreener/token-batch-addresses.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

function pair(
  pairAddress: string,
  baseAddress: string,
  quoteAddress: string,
  priceUsd: string | null,
  priceNative: string,
): DexPair {
  return {
    chainId: "solana",
    dexId: "test-dex",
    url: `https://dexscreener.com/solana/${pairAddress}`,
    pairAddress,
    labels: null,
    baseToken: { address: baseAddress, name: baseAddress, symbol: baseAddress },
    quoteToken: { address: quoteAddress, name: quoteAddress, symbol: quoteAddress },
    priceNative,
    priceUsd,
    txns: { h24: { buys: 1, sells: 1 } },
    volume: { h24: 100 },
    priceChange: { h24: 0 },
    liquidity: { usd: 1_000, base: 10, quote: 10 },
    fdv: null,
    marketCap: null,
    pairCreatedAt: null,
    info: null,
    boosts: null,
  };
}

describe("DexScreener requested-token price correctness", () => {
  it("normalizes quote-side pools before computing the median and outliers", () => {
    const requested = "RequestedMint";
    const rows = toPairRows([
      // Raw base price is 100, but requested quote-token price is 100 / 50 = 2.
      pair("quote-normal", "BaseA", requested, "100", "50"),
      pair("base-normal", requested, "QuoteA", "2.1", "1"),
      // Raw base price is 210, but requested quote-token price is 210 / 100 = 2.1.
      pair("quote-normal-2", "BaseB", requested, "210", "100"),
      pair("quote-outlier", "BaseC", requested, "400", "10"),
    ], Date.now());

    const result = assessCrossPoolPrices(rows, {
      tokenAddress: requested,
      caseSensitiveAddress: true,
    });

    expect(result.priceUsdMedianAcrossPools).toBe("2.1");
    expect(result.requestedTokenPriceUsdByRow.get(rows[0]!)).toBe("2");
    expect(result.requestedTokenSideByRow.get(rows[0]!)).toBe("quote");
    expect(result.verdictByRow.get(rows[0]!)).toBe("ok");
    expect(result.verdictByRow.get(rows[3]!)).toBe("outlier_vs_pool_median");
    expect(result.pricePoolOutliers).toEqual([
      expect.objectContaining({
        pairAddress: "quote-outlier",
        requestedTokenPriceUsd: "40",
        requestedTokenSide: "quote",
      }),
    ]);
  });

  it("does not case-fold Solana identities during batch reconciliation", () => {
    const provider = [pair("p", "CaseSensitiveMint", "Q", "1", "1")];
    const echo = reconcileTokenBatchAddresses(
      "CaseSensitiveMint,casesensitivemint",
      provider,
      true,
    );
    expect(echo.resolvedAddresses).toEqual(["CaseSensitiveMint"]);
    expect(echo.unresolvedAddresses).toEqual(["casesensitivemint"]);
  });

  it("preserves the requested-token side when a pool price is unreadable", () => {
    const requested = "RequestedMint";
    const rows = toPairRows([
      pair("missing-price", "BaseMint", requested, null, "50"),
    ], Date.now());

    const result = assessCrossPoolPrices(rows, {
      tokenAddress: requested,
      caseSensitiveAddress: true,
    });

    expect(result.requestedTokenSideByRow.get(rows[0]!)).toBe("quote");
    expect(result.requestedTokenPriceUsdByRow.get(rows[0]!)).toBeNull();
    expect(result.verdictByRow.get(rows[0]!)).toBe("unknown");
  });
});

describe("DexScreener core handler correctness", () => {
  afterEach(() => vi.restoreAllMocks());

  it("chunks 40 addresses, merges both calls, and preserves complete reconciliation", async () => {
    const addresses = Array.from({ length: 40 }, (_, index) => `token-${index}`);
    const getTokens = vi.spyOn(getDexScreenerClient(), "getTokens").mockImplementation(
      async (_chain, requested) => requested.split(",").map((address) =>
        pair(`pool-${address}`, address, "USD", "1", "1")),
    );
    const handler = DEXSCREENER_HANDLERS["dexscreener.tokens"];
    if (handler === undefined) throw new Error("missing tokens handler");

    const result = await handler({ chain: "solana", tokenAddresses: addresses }, READ_CTX);
    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      requestedAddresses: string[];
      resolvedAddresses: string[];
      unresolvedAddresses: string[];
      batchRequestCount: number;
      providerWindow: { providerReturned: number; providerCap: number | null };
      returned: number;
      hasMore: boolean;
    };

    expect(getTokens).toHaveBeenCalledTimes(2);
    expect(getTokens.mock.calls.map((call) => call[1].split(",").length)).toEqual([30, 10]);
    expect(data.requestedAddresses).toEqual(addresses);
    expect(data.resolvedAddresses).toEqual(addresses);
    expect(data.unresolvedAddresses).toEqual([]);
    expect(data.batchRequestCount).toBe(2);
    expect(data.providerWindow.providerReturned).toBe(40);
    expect(data.providerWindow.providerCap).toBeNull();
    expect(data.returned).toBe(15);
    expect(data.hasMore).toBe(true);
  });

  it("keeps a fully resolved 60-address default response within the context budget", async () => {
    const addresses = Array.from({ length: 60 }, (_, index) =>
      `0x${index.toString(16).padStart(40, "0")}`);
    vi.spyOn(getDexScreenerClient(), "getTokens").mockImplementation(
      async (_chain, requested) => requested.split(",").map((address) =>
        pair(`pool-${address}`, address, "USD", "1", "1")),
    );

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "ethereum", tokenAddresses: addresses },
      READ_CTX,
    );

    expect(result.success, result.output).toBe(true);
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThan(16_384);
    expect(JSON.parse(result.output)).toMatchObject({
      requestedAddresses: addresses,
      resolvedAddresses: addresses,
      unresolvedAddresses: [],
      batchRequestCount: 2,
      returned: 15,
      hasMore: true,
    });
  });

  it("chunks 31 pair addresses into provider-safe calls and merges every result", async () => {
    const addresses = Array.from({ length: 31 }, (_, index) => `pair-${index}`);
    const getPairs = vi.spyOn(getDexScreenerClient(), "getPairs").mockImplementation(
      async (_chain, requested) => ({
        schemaVersion: "1.0.0",
        pairs: requested.split(",").map((address) =>
          pair(address, `base-${address}`, "USD", "1", "1")),
      }),
    );
    const handler = DEXSCREENER_HANDLERS["dexscreener.pairs"]!;

    const result = await handler({ chain: "solana", pairAddress: addresses }, READ_CTX);
    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      resolvedPairAddresses: string[];
      unresolvedPairAddresses: string[];
      batchRequestCount: number;
      providerWindow: { providerReturned: number; providerCap: number | null };
    };

    expect(getPairs).toHaveBeenCalledTimes(2);
    expect(getPairs.mock.calls.map((call) => call[1].split(",").length)).toEqual([30, 1]);
    expect(data.resolvedPairAddresses).toEqual(addresses);
    expect(data.unresolvedPairAddresses).toEqual([]);
    expect(data.batchRequestCount).toBe(2);
    expect(data.providerWindow).toMatchObject({ providerReturned: 31, providerCap: null });
  });

  it("rejects delimiter-only address lists before calling DexScreener", async () => {
    const client = getDexScreenerClient();
    const getPairs = vi.spyOn(client, "getPairs");
    const getTokens = vi.spyOn(client, "getTokens");

    const pairs = await DEXSCREENER_HANDLERS["dexscreener.pairs"]!(
      { chain: "solana", pairAddress: ", ," },
      READ_CTX,
    );
    const tokens = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "solana", tokenAddresses: [" ", ","] },
      READ_CTX,
    );

    expect(pairs.success).toBe(false);
    expect(tokens.success).toBe(false);
    expect(getPairs).not.toHaveBeenCalled();
    expect(getTokens).not.toHaveBeenCalled();
  });

  it("rejects more than 60 addresses before calling DexScreener", async () => {
    const getTokens = vi.spyOn(getDexScreenerClient(), "getTokens");
    const addresses = Array.from({ length: 61 }, (_, index) => `token-${index}`);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "solana", tokenAddresses: addresses },
      READ_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("at most 60");
    expect(getTokens).not.toHaveBeenCalled();
  });

  it("preserves case-distinct addresses on an unknown non-EVM chain", async () => {
    const getTokens = vi.spyOn(getDexScreenerClient(), "getTokens").mockResolvedValue([
      pair("pool", "CaseSensitive", "USD", "1", "1"),
    ]);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "ton", tokenAddresses: ["CaseSensitive", "casesensitive"] },
      READ_CTX,
    );
    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      resolvedAddresses: string[];
      unresolvedAddresses: string[];
    };

    expect(getTokens).toHaveBeenCalledWith("ton", "CaseSensitive,casesensitive");
    expect(data.resolvedAddresses).toEqual(["CaseSensitive"]);
    expect(data.unresolvedAddresses).toEqual(["casesensitive"]);
  });

  it("case-folds canonical EVM addresses on a DexScreener chain outside Vex's registry", async () => {
    const checksum = "0xA00000000000000000000000000000000000000B";
    const lowercase = checksum.toLowerCase();
    const getTokens = vi.spyOn(getDexScreenerClient(), "getTokens").mockResolvedValue([
      pair("pool", lowercase, "USD", "1", "1"),
    ]);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "fantom", tokenAddresses: checksum },
      READ_CTX,
    );
    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      resolvedAddresses: string[];
      unresolvedAddresses: string[];
    };

    expect(getTokens).toHaveBeenCalledWith("fantom", checksum);
    expect(data.resolvedAddresses).toEqual([checksum]);
    expect(data.unresolvedAddresses).toEqual([]);
  });

  it("labels which token identity matched a search result", async () => {
    vi.spyOn(getDexScreenerClient(), "search").mockResolvedValue({
      schemaVersion: "1.0.0",
      pairs: [pair("pool", "BaseMint", "RequestedMint", "2", "1")],
    });

    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "RequestedMint" },
      READ_CTX,
    );
    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      pairs: Array<{
        queryMatchSide: string;
        queryMatchKind: string;
        queryMatchedTokenAddress: string | null;
      }>;
    };

    expect(data.pairs[0]).toMatchObject({
      queryMatchSide: "quote",
      queryMatchKind: "address",
      queryMatchedTokenAddress: "RequestedMint",
    });
  });
});

describe("DexScreener batch partial-failure accounting", () => {
  afterEach(() => vi.restoreAllMocks());

  it("merges completed batches and reports a failed batch per address, not as total failure", async () => {
    const addresses = Array.from({ length: 40 }, (_, index) => `token-${index}`);
    const getTokens = vi.spyOn(getDexScreenerClient(), "getTokens").mockImplementation(
      async (_chain, requested) => {
        const batch = requested.split(",");
        if (batch.length === 10) throw new Error("DexScreener answered HTTP 429: rate limited");
        return batch.map((address) => pair(`pool-${address}`, address, "USD", "1", "1"));
      },
    );

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "solana", tokenAddresses: addresses },
      READ_CTX,
    );

    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      resolvedAddresses: string[];
      unresolvedAddresses: string[];
      unreachedAddresses: string[];
      failedBatchCount: number;
      batchRequestCount: number;
      providerWindow: { note?: string };
      sourceObservation: {
        observed: boolean;
        providerFetchedAtMs: number | null;
        localCacheAgeMs: number | null;
        dataAgeMs: number | null;
      };
    };

    expect(getTokens).toHaveBeenCalledTimes(2);
    expect(data.resolvedAddresses).toEqual(addresses.slice(0, 30));
    // The failed batch's addresses are UNREACHED (never answered — retry), not
    // "unresolved" (answered without them): conflating the two reads a
    // transport failure as "not indexed".
    expect(data.unreachedAddresses).toEqual(addresses.slice(30));
    expect(data.unresolvedAddresses).toEqual([]);
    expect(data.failedBatchCount).toBe(1);
    expect(data.batchRequestCount).toBe(2);
    expect(data.providerWindow.note).toContain("FAILED");
    expect(data.providerWindow.note).toContain("rate limited");
    // Test doubles carry no transport metadata: the observation must DECLINE,
    // never fabricate "fetched now, age 0".
    expect(data.sourceObservation.observed).toBe(false);
    expect(data.sourceObservation.providerFetchedAtMs).toBeNull();
    expect(data.sourceObservation.localCacheAgeMs).toBeNull();
    expect(data.sourceObservation.dataAgeMs).toBeNull();
  });

  it("fails with the real cause when every batch fails", async () => {
    vi.spyOn(getDexScreenerClient(), "getTokens").mockRejectedValue(
      new Error("DexScreener answered HTTP 429: rate limited"),
    );

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "solana", tokenAddresses: "token-a,token-b" },
      READ_CTX,
    );

    expect(result.success).toBe(false);
    expect(result.output).toContain("every DexScreener batch failed");
    expect(result.output).toContain("rate limited");
  });

  it("pairs reports a failed batch in unreachedPairAddresses", async () => {
    const addresses = Array.from({ length: 40 }, (_, index) => `pool-${index}`);
    vi.spyOn(getDexScreenerClient(), "getPairs").mockImplementation(
      async (_chain, requested) => {
        const batch = requested.split(",");
        if (batch.length === 10) throw new Error("DexScreener answered HTTP 500");
        return {
          schemaVersion: "1.0.0",
          pairs: batch.map((address) => pair(address, `base-${address}`, "USD", "1", "1")),
        };
      },
    );

    const result = await DEXSCREENER_HANDLERS["dexscreener.pairs"]!(
      { chain: "solana", pairAddress: addresses },
      READ_CTX,
    );

    expect(result.success, result.output).toBe(true);
    const data = JSON.parse(result.output) as {
      resolvedPairAddresses: string[];
      unresolvedPairAddresses: string[];
      unreachedPairAddresses: string[];
      failedBatchCount: number;
    };
    expect(data.resolvedPairAddresses).toEqual(addresses.slice(0, 30));
    expect(data.unreachedPairAddresses).toEqual(addresses.slice(30));
    expect(data.unresolvedPairAddresses).toEqual([]);
    expect(data.failedBatchCount).toBe(1);
  });
});

describe("DexScreener requireLiquidityUsd", () => {
  afterEach(() => vi.restoreAllMocks());

  it("drops unknown-liquidity rows only on request, with the drop counted", async () => {
    const withLiquidity = pair("pool-liquid", "TokenA", "USD", "1", "1");
    const bondingCurve: DexPair = {
      ...pair("pool-curve", "TokenB", "USD", "1", "1"),
      liquidity: null,
    };
    vi.spyOn(getDexScreenerClient(), "search").mockResolvedValue({
      schemaVersion: "1.0.0",
      pairs: [withLiquidity, bondingCurve],
    });

    const kept = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "TokenA", requireLiquidityUsd: true },
      READ_CTX,
    );
    expect(kept.success, kept.output).toBe(true);
    const keptData = JSON.parse(kept.output) as {
      returned: number;
      droppedByFilter: Record<string, number>;
      filtersApplied: Record<string, unknown>;
    };
    expect(keptData.returned).toBe(1);
    expect(keptData.droppedByFilter.requireLiquidityUsd).toBe(1);
    expect(keptData.filtersApplied.requireLiquidityUsd).toBe(true);

    // Off by default: a bonding-curve holding must never vanish unasked.
    const all = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "TokenA" },
      READ_CTX,
    );
    expect(all.success, all.output).toBe(true);
    expect((JSON.parse(all.output) as { returned: number }).returned).toBe(2);
  });
});
