import { describe, it, expect, vi, afterEach } from "vitest";
import { DEXSCREENER_HANDLERS } from "../../../vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "../../../vex-agent/tools/protocols/dexscreener/manifest.js";
import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import type { DexBoost, DexBoostFeed, DexPair, DexTokenProfile } from "@tools/dexscreener/types.js";
import type { ProtocolExecutionContext } from "../../../vex-agent/tools/protocols/types.js";

/**
 * A fully-typed read-only execution context.
 *
 * The inline `{ sessionPermission, approved }` literals elsewhere in this file
 * predate `ProtocolExecutionContext` gaining `walletResolution`/`walletPolicy`
 * and no longer satisfy it (they are carried in the test-type baseline). Tests
 * added here use this instead, so new call sites do not enlarge that debt.
 * DexScreener handlers are read-only and touch no wallet, so the neutral
 * "default"/"none" pair is the honest value, not a stub standing in for one.
 */
const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

describe("dexscreener handlers", () => {
  // ── Handler coverage ─────────────────────────────────────────────

  it("has a handler for every manifest toolId", () => {
    const handlerKeys = new Set(Object.keys(DEXSCREENER_HANDLERS));
    const manifestIds = DEXSCREENER_TOOLS.map(t => t.toolId);
    const missing = manifestIds.filter(id => !handlerKeys.has(id));
    expect(missing).toEqual([]);
  });

  it("has no extra handlers without manifests", () => {
    const manifestIds = new Set(DEXSCREENER_TOOLS.map(t => t.toolId));
    const handlerKeys = Object.keys(DEXSCREENER_HANDLERS);
    const extra = handlerKeys.filter(key => !manifestIds.has(key));
    expect(extra).toEqual([]);
  });

  it("handler count matches manifest count (14)", () => {
    expect(Object.keys(DEXSCREENER_HANDLERS)).toHaveLength(14);
  });

  it("every handler is a function", () => {
    for (const [, handler] of Object.entries(DEXSCREENER_HANDLERS)) {
      expect(typeof handler).toBe("function");
    }
  });

  // ── Required param validation ────────────────────────────────────

  it("dexscreener.search fails without query", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("query");
  });

  it("dexscreener.pairs fails without chainId and pairAddress", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.pairs"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chainId");
  });

  it("dexscreener.pairs fails with only chainId", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.pairs"]!(
      { chainId: "ethereum" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("pairAddress");
  });

  it("dexscreener.tokens fails without chainId and tokenAddresses", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chainId");
  });

  it("dexscreener.tokens fails with only chainId", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chainId: "ethereum" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("tokenAddresses");
  });

  it("dexscreener.tokenPairs fails without chainId and tokenAddress", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chainId");
  });

  it("dexscreener.tokenPairs fails with only chainId", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chainId: "solana" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("tokenAddress");
  });

  it("dexscreener.orders fails without chainId and tokenAddress", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.orders"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chainId");
  });

  it("dexscreener.orders fails with only chainId", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.orders"]!(
      { chainId: "solana" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("tokenAddress");
  });

  // ── Read-only handlers return data (no wallet needed) ────────────

  it("dexscreener.search returns pairs for a known query", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "USDC" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.query).toBe("USDC");
    expect(typeof data.pairCount).toBe("number");
    expect(Array.isArray(data.pairs)).toBe(true);
  });

  it("dexscreener.profiles returns profiles array", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.profiles"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.count).toBe("number");
    expect(Array.isArray(data.profiles)).toBe(true);
  });

  it("dexscreener.boosts returns boosts array", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.boosts"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.count).toBe("number");
    expect(Array.isArray(data.boosts)).toBe(true);
    expect(data.skipped).toBe(0);
  });

  // Live regression guard: this tool threw on 100% of calls because the shared
  // boost schema required `amount`, which `/token-boosts/top/v1` never sends.
  it("dexscreener.boosts.top returns rows against the LIVE top feed", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.boosts.top"]!({}, READ_CTX);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.count).toBeGreaterThan(0);
    expect(data.skipped).toBe(0);
    expect(data.boosts[0].chainId).toBeTruthy();
    expect(data.boosts[0].tokenAddress).toBeTruthy();
  });

  // Same for orders: the live root is `{orders, boosts}`, which the validator
  // rejected outright.
  it("dexscreener.orders returns the envelope against the LIVE endpoint", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.orders"]!(
      { chainId: "solana", tokenAddress: "A55XjvzRU4KtR3Lrys8PpLZQvPojPqvnv5bJVHMYy3Jv" },
      READ_CTX,
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.orderCount).toBeGreaterThan(0);
    expect(Array.isArray(data.boostPayments)).toBe(true);
    expect(data.skippedOrders).toBe(0);
    // Milliseconds: read as seconds this row lands in the year ~58,000.
    const ms = data.orders[0].paymentTimestampMs;
    expect(new Date(ms).getUTCFullYear()).toBeGreaterThanOrEqual(2020);
  });

  it("dexscreener.attention returns merged items", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.attention"]!(
      { limit: 5 },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.count).toBe("number");
    expect(data.count).toBeLessThanOrEqual(5);
    expect(Array.isArray(data.items)).toBe(true);
    if (data.items.length > 0) {
      expect(data.items[0].chainId).toBeDefined();
      expect(data.items[0].tokenAddress).toBeDefined();
      // `null` is legitimate — the feed did not report a boost total — and is
      // deliberately NOT coerced to 0.
      expect(["number", "object"]).toContain(typeof data.items[0].boostTotalAmount);
      expect(typeof data.items[0].hasProfile).toBe("boolean");
    }
  });

  it("dexscreener.ads returns ads array", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.ads"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.count).toBe("number");
    expect(Array.isArray(data.ads)).toBe(true);
  });
});

// ── Deterministic sort / limit / projection (no live network) ──────
//
// These spy on the shared singleton client (`getDexScreenerClient()`) so the
// handler's sort/limit/projection logic is exercised against crafted fixtures
// instead of `https://api.dexscreener.com`. Spies are restored after each test
// so the live-network integration tests above stay untouched.

const PERM = { sessionPermission: "restricted" as const, approved: false };

/** Minimal valid `DexPair` fixture — only the fields the handler/projector read matter. */
function makePair(overrides: Partial<DexPair>): DexPair {
  return {
    chainId: "solana",
    dexId: "raydium",
    url: "https://dexscreener.com/solana/abc",
    pairAddress: "PAIRabc",
    labels: null,
    baseToken: { address: "BASE", name: "Base", symbol: "BASE" },
    quoteToken: { address: "QUOTE", name: "Quote", symbol: "QUOTE" },
    priceNative: "1",
    priceUsd: "1.00",
    txns: { h24: { buys: 1, sells: 1 } },
    volume: { h24: 1000 },
    priceChange: { h24: 0 },
    liquidity: { usd: 0, base: 0, quote: 0 },
    fdv: 0,
    marketCap: 0,
    pairCreatedAt: 0,
    info: { imageUrl: "https://img/x.png", websites: null, socials: null },
    boosts: { active: 0 },
    ...overrides,
  };
}

describe("dexscreener.tokenPairs sort / limit / projection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sorts pairs by liquidity.usd descending", async () => {
    const client = getDexScreenerClient();
    const pairs: DexPair[] = [
      makePair({ dexId: "low", liquidity: { usd: 10, base: 1, quote: 1 } }),
      makePair({ dexId: "high", liquidity: { usd: 1000, base: 1, quote: 1 } }),
      makePair({ dexId: "mid", liquidity: { usd: 500, base: 1, quote: 1 } }),
    ];
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(pairs);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chainId: "solana", tokenAddress: "TOKEN" },
      PERM,
    );
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.pairs.map((x: { dexId: string }) => x.dexId)).toEqual(["high", "mid", "low"]);
  });

  it("sinks null-liquidity pairs to the bottom (null-coalesced to -Infinity)", async () => {
    const client = getDexScreenerClient();
    const pairs: DexPair[] = [
      makePair({ dexId: "nullLiq", liquidity: { usd: null, base: 0, quote: 0 } }),
      makePair({ dexId: "noLiqBlock", liquidity: null }),
      makePair({ dexId: "real", liquidity: { usd: 5, base: 1, quote: 1 } }),
    ];
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(pairs);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chainId: "solana", tokenAddress: "TOKEN" },
      PERM,
    );
    const data = JSON.parse(result.output);
    expect(data.pairs[0].dexId).toBe("real");
    expect(data.pairs.length).toBe(3);
  });

  it("applies limit when provided (top-N after sort)", async () => {
    const client = getDexScreenerClient();
    const pairs: DexPair[] = [
      makePair({ dexId: "a", liquidity: { usd: 10, base: 1, quote: 1 } }),
      makePair({ dexId: "b", liquidity: { usd: 1000, base: 1, quote: 1 } }),
      makePair({ dexId: "c", liquidity: { usd: 500, base: 1, quote: 1 } }),
    ];
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(pairs);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chainId: "solana", tokenAddress: "TOKEN", limit: 2 },
      PERM,
    );
    const data = JSON.parse(result.output);
    expect(data.pairCount).toBe(2);
    expect(data.pairs.map((x: { dexId: string }) => x.dexId)).toEqual(["b", "c"]);
  });

  it("returns all pairs (no truncation) when limit is omitted", async () => {
    const client = getDexScreenerClient();
    const pairs: DexPair[] = Array.from({ length: 30 }, (_, i) =>
      makePair({ dexId: `dex${i}`, liquidity: { usd: i, base: 1, quote: 1 } }),
    );
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(pairs);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chainId: "solana", tokenAddress: "TOKEN" },
      PERM,
    );
    const data = JSON.parse(result.output);
    expect(data.pairCount).toBe(30);
  });

  it("projects pairs to the concise flat shape — keeps trading fields, drops raw noise", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getTokenPairs").mockResolvedValue([
      makePair({
        chainId: "ethereum",
        dexId: "uniswap",
        labels: ["v3"],
        priceNative: "0.002",
        liquidity: { usd: 42, base: 1, quote: 2 },
        fdv: 100,
        marketCap: 90,
        volume: { h24: 5000, h6: 1000, h1: 200, m5: 10 },
        priceChange: { h1: 5, h6: 3, h24: -2, m5: 0.5 },
        txns: { h24: { buys: 7, sells: 3 }, h1: { buys: 1, sells: 0 } },
        pairCreatedAt: 1700000000,
        priceUsd: "3.14",
      }),
    ]);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chainId: "ethereum", tokenAddress: "TOKEN" },
      PERM,
    );
    const data = JSON.parse(result.output);
    const pair = data.pairs[0];

    // KEEP — identity + flat trading facts
    expect(pair.chainId).toBe("ethereum");
    expect(pair.dexId).toBe("uniswap");
    expect(pair.pairAddress).toBe("PAIRabc"); // load-bearing for the zap pool-address workflow
    expect(pair.baseToken).toEqual({ address: "BASE", name: "Base", symbol: "BASE" });
    expect(pair.quoteToken).toEqual({ address: "QUOTE", name: "Quote", symbol: "QUOTE" });
    expect(pair.priceUsd).toBe("3.14");
    expect(pair.priceNative).toBe("0.002");
    expect(pair.liquidityUsd).toBe(42);
    expect(pair.fdv).toBe(100);
    expect(pair.marketCap).toBe(90);
    expect(pair.volumeH24).toBe(5000);
    expect(pair.priceChangeH1).toBe(5);
    expect(pair.priceChangeH24).toBe(-2);
    expect(pair.txnsH24).toEqual({ buys: 7, sells: 3 });
    expect(pair.pairCreatedAt).toBe(1700000000);
    expect(pair.labels).toEqual(["v3"]);

    // DROP — raw noise and non-h24 windows
    expect(pair.info).toBeUndefined();
    expect(pair.url).toBeUndefined();
    expect(pair.boosts).toBeUndefined();
    expect(pair.txns).toBeUndefined();
    expect(pair.volume).toBeUndefined();
    expect(pair.priceChange).toBeUndefined();
    expect(pair.liquidity).toBeUndefined(); // flattened to liquidityUsd
  });
});

/** Wrap crafted boost rows in the feed envelope the client now returns. */
function feedOf(boosts: DexBoost[]): DexBoostFeed {
  return { boosts, skipped: 0 };
}

describe("dexscreener.attention default limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to 20 results when limit is omitted", async () => {
    const client = getDexScreenerClient();
    // 25 distinct boosted tokens → merged feed of 25, default limit must trim to 20.
    const boosts: DexBoost[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://dexscreener.com/solana/t${i}`,
      chainId: "solana",
      tokenAddress: `TOKEN${i}`,
      amount: 25 - i,
      totalAmount: 25 - i,
      icon: null,
      header: null,
      description: null,
      links: null,
    }));
    const profiles: DexTokenProfile[] = [];
    vi.spyOn(client, "getBoosts").mockResolvedValue(feedOf(boosts));
    vi.spyOn(client, "getProfiles").mockResolvedValue(profiles);

    const result = await DEXSCREENER_HANDLERS["dexscreener.attention"]!({}, PERM);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.count).toBe(20);
    expect(data.items.length).toBe(20);
  });

  it("respects an explicit limit over the default", async () => {
    const client = getDexScreenerClient();
    const boosts: DexBoost[] = Array.from({ length: 25 }, (_, i) => ({
      url: `https://dexscreener.com/solana/t${i}`,
      chainId: "solana",
      tokenAddress: `TOKEN${i}`,
      amount: 25 - i,
      totalAmount: 25 - i,
      icon: null,
      header: null,
      description: null,
      links: null,
    }));
    vi.spyOn(client, "getBoosts").mockResolvedValue(feedOf(boosts));
    vi.spyOn(client, "getProfiles").mockResolvedValue([]);

    const result = await DEXSCREENER_HANDLERS["dexscreener.attention"]!({ limit: 5 }, PERM);
    const data = JSON.parse(result.output);
    expect(data.count).toBe(5);
  });
});

// ── Search client-side filters (chainId / minLiquidityUsd / limit) ─

describe("dexscreener.search filters", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function searchPairs(): DexPair[] {
    return [
      makePair({ chainId: "base", dexId: "a", liquidity: { usd: 100000, base: 1, quote: 1 } }),
      makePair({ chainId: "ethereum", dexId: "b", liquidity: { usd: 5000, base: 1, quote: 1 } }),
      makePair({ chainId: "base", dexId: "c", liquidity: { usd: 200, base: 1, quote: 1 } }),
      makePair({ chainId: "solana", dexId: "d", liquidity: { usd: 900000, base: 1, quote: 1 } }),
    ];
  }

  it("filters by chainId (case-insensitive) and sorts by liquidity desc", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: searchPairs() });

    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "x", chainId: "BASE" },
      PERM,
    );
    const data = JSON.parse(result.output);
    expect(data.chainId).toBe("BASE");
    expect(data.pairs.every((pr: { chainId: string }) => pr.chainId === "base")).toBe(true);
    expect(data.pairs.map((pr: { dexId: string }) => pr.dexId)).toEqual(["a", "c"]);
  });

  it("filters by minLiquidityUsd", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: searchPairs() });

    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "x", minLiquidityUsd: 10000 },
      PERM,
    );
    const data = JSON.parse(result.output);
    // Only base@100k and solana@900k clear the 10k floor; sorted desc.
    expect(data.pairs.map((pr: { dexId: string }) => pr.dexId)).toEqual(["d", "a"]);
    expect(data.matched).toBe(2);
  });

  it("caps results at the default limit (20) and honors an explicit limit", async () => {
    const client = getDexScreenerClient();
    const many: DexPair[] = Array.from({ length: 30 }, (_, i) =>
      makePair({ chainId: "base", dexId: `d${i}`, liquidity: { usd: 30 - i, base: 1, quote: 1 } }),
    );
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: many });

    const def = JSON.parse(
      (await DEXSCREENER_HANDLERS["dexscreener.search"]!({ query: "x" }, PERM)).output,
    );
    expect(def.pairCount).toBe(20);

    const capped = JSON.parse(
      (await DEXSCREENER_HANDLERS["dexscreener.search"]!({ query: "x", limit: 3 }, PERM)).output,
    );
    expect(capped.pairCount).toBe(3);
  });
});

// ── Metas / recent-updates handlers (mocked client) ────────────────

describe("dexscreener metas + recent handlers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("dexscreener.trending returns narratives and honors limit", async () => {
    const client = getDexScreenerClient();
    const metas = Array.from({ length: 5 }, (_, i) => ({
      slug: `m${i}`,
      name: `Meta ${i}`,
      description: null,
      icon: null,
      marketCap: i,
      liquidity: i,
      volume: i,
      tokenCount: i,
      marketCapChange: null,
      marketCapDelta: null,
    }));
    vi.spyOn(client, "getMetasTrending").mockResolvedValue(metas);

    const result = await DEXSCREENER_HANDLERS["dexscreener.trending"]!({ limit: 3 }, PERM);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.count).toBe(3);
    expect(data.metas[0].slug).toBe("m0");
    // `available: true` is gone — `success` already carries that signal, and the
    // flag only existed to pair with a success-shaped FAILURE.
    expect(data.available).toBeUndefined();
  });

  // The defect this replaces: the handler caught every error WITHOUT binding it
  // and returned `ok({available:false, reason:"…undocumented endpoint that may
  // have changed"})` — a success row for a failed call, asserting a cause nobody
  // had established. The error must now propagate so the runtime can classify
  // the REAL one.
  it("dexscreener.trending propagates the failure instead of reporting success", async () => {
    const client = getDexScreenerClient();
    const rateLimited = new VexError(
      ErrorCodes.DEXSCREENER_RATE_LIMITED,
      "DexScreener API returned HTTP 429",
      "Wait and retry.",
    );
    rateLimited.retryable = true;
    vi.spyOn(client, "getMetasTrending").mockRejectedValue(rateLimited);

    await expect(DEXSCREENER_HANDLERS["dexscreener.trending"]!({}, PERM)).rejects.toBe(rateLimited);
  });

  it("dexscreener.meta requires slug", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.meta"]!({}, PERM);
    expect(result.success).toBe(false);
    expect(result.output).toContain("slug");
  });

  it("dexscreener.meta projects narrative pairs and keeps aggregate stats", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getMeta").mockResolvedValue({
      slug: "knockoff-legends",
      name: "Knockoff Legends",
      description: "x",
      icon: null,
      marketCap: 123,
      liquidity: 456,
      volume: 789,
      tokenCount: 2,
      marketCapChange: null,
      marketCapDelta: null,
      pairs: [makePair({ dexId: "raydium", liquidity: { usd: 10, base: 1, quote: 1 } })],
    });

    const result = await DEXSCREENER_HANDLERS["dexscreener.meta"]!({ slug: "knockoff-legends" }, PERM);
    const data = JSON.parse(result.output);
    expect(data.slug).toBe("knockoff-legends");
    expect(data.tokenCount).toBe(2);
    expect(data.pairCount).toBe(1);
    // Pairs are projected to the concise flat shape.
    expect(data.pairs[0].liquidityUsd).toBe(10);
    expect(data.pairs[0].url).toBeUndefined();
  });

  // An unreadable payload IS an established cause (the provider answered; the
  // body did not match the shape), so it is reported as a FAILURE naming exactly
  // that — and nothing more.
  it("dexscreener.meta fails honestly when the payload cannot be read", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getMeta").mockResolvedValue(null);

    const result = await DEXSCREENER_HANDLERS["dexscreener.meta"]!({ slug: "gone" }, PERM);
    expect(result.success).toBe(false);
    expect(result.output).toContain("did not match the expected shape");
    expect(result.output).toContain("gone");
    // No fabricated cause, and no advice to abandon the tool.
    expect(result.output).not.toContain("undocumented");
  });

  it("dexscreener.profiles.recent returns profiles and propagates failures", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getProfilesRecentUpdates").mockResolvedValue([
      {
        url: "u", chainId: "bsc", tokenAddress: "0xabc", icon: "i",
        header: null, description: null, links: null,
        updatedAt: "2026-07-04T00:00:00.000Z", cto: false,
      },
    ]);
    const okResult = JSON.parse(
      (await DEXSCREENER_HANDLERS["dexscreener.profiles.recent"]!({}, PERM)).output,
    );
    expect(okResult.count).toBe(1);
    expect(okResult.available).toBeUndefined();

    const boom = new Error("boom");
    vi.spyOn(client, "getProfilesRecentUpdates").mockRejectedValue(boom);
    await expect(DEXSCREENER_HANDLERS["dexscreener.profiles.recent"]!({}, PERM)).rejects.toBe(boom);
  });
});
