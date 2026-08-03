import { describe, it, expect, vi, afterEach } from "vitest";
import { DEXSCREENER_HANDLERS } from "../../../vex-agent/tools/protocols/dexscreener/handlers.js";
import { DEXSCREENER_TOOLS } from "../../../vex-agent/tools/protocols/dexscreener/manifest.js";
import { getDexScreenerClient } from "@tools/dexscreener/client.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import type { DexBoost, DexBoostFeed, DexPair, DexTokenProfile } from "@tools/dexscreener/types.js";
import type { ProtocolExecutionContext, ProtocolHandler } from "../../../vex-agent/tools/protocols/types.js";

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

  it("dexscreener.pairs fails without chain and pairAddress", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.pairs"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("dexscreener.pairs fails with only chain", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.pairs"]!(
      { chain: "ethereum" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("pairAddress");
  });

  it("dexscreener.tokens fails without chain and tokenAddresses", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("dexscreener.tokens fails with only chain", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokens"]!(
      { chain: "ethereum" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("tokenAddresses");
  });

  it("dexscreener.tokenPairs fails without chain and tokenAddress", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("dexscreener.tokenPairs fails with only chain", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chain: "solana" },
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("tokenAddress");
  });

  it("dexscreener.orders fails without chain and tokenAddress", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.orders"]!(
      {},
      { sessionPermission: "restricted", approved: false },
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("chain");
  });

  it("dexscreener.orders fails with only chain", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.orders"]!(
      { chain: "solana" },
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
    // `pairCount` is gone: the provenance envelope carries `returned` (rows in
    // this payload) and `totalMatched` (rows that survived the filters), which
    // the old single count could not distinguish.
    expect(typeof data.returned).toBe("number");
    expect(typeof data.totalMatched).toBe("number");
    expect(Array.isArray(data.pairs)).toBe(true);
  });

  // The feed tools now emit the shared list envelope + `rows`, replacing the
  // `{count, profiles}` / `{count, boosts}` / `{count, ads}` / `{count, items}`
  // shapes. `count` is gone because it could not distinguish "rows in this
  // payload" from "rows that survived the filters" — the envelope's `returned` and
  // `totalMatched` do.
  it("dexscreener.profiles returns the envelope and rows against the LIVE feed", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.profiles"]!({}, READ_CTX);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.returned).toBe("number");
    expect(typeof data.totalMatched).toBe("number");
    expect(Array.isArray(data.rows)).toBe(true);
    // The two fields this feed used to parse and discard.
    expect(typeof data.rows[0].updatedAt).toBe("string");
    expect(data.rows[0]).toHaveProperty("communityTakeover");
  });

  it("dexscreener.boosts returns the envelope and rows against the LIVE feed", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.boosts"]!({}, READ_CTX);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.returned).toBe("number");
    expect(Array.isArray(data.rows)).toBe(true);
    expect(data.skippedRows).toBe(0);
  });

  // Live regression guard: this tool threw on 100% of calls because the shared
  // boost schema required `amount`, which `/token-boosts/top/v1` never sends.
  it("dexscreener.boosts.top returns rows against the LIVE top feed", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.boosts.top"]!({}, READ_CTX);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.returned).toBeGreaterThan(0);
    expect(data.skippedRows).toBe(0);
    expect(data.rows[0].chainId).toBeTruthy();
    expect(data.rows[0].tokenAddress).toBeTruthy();
    // Still null on this feed, and still NOT coerced to zero.
    expect(data.rows[0].boostCount).toBeNull();
    expect(typeof data.rows[0].boostCountTotal).toBe("number");
  });

  // Same for orders: the live root is `{orders, boosts}`, which the validator
  // rejected outright.
  it("dexscreener.orders returns the envelope against the LIVE endpoint", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.orders"]!(
      { chain: "solana", tokenAddress: "A55XjvzRU4KtR3Lrys8PpLZQvPojPqvnv5bJVHMYy3Jv" },
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

  it("dexscreener.attention returns merged rows against the LIVE feeds", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.attention"]!({ limit: 5 }, READ_CTX);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.returned).toBeLessThanOrEqual(5);
    expect(Array.isArray(data.rows)).toBe(true);
    if (data.rows.length > 0) {
      expect(data.rows[0].chainId).toBeDefined();
      expect(data.rows[0].tokenAddress).toBeDefined();
      // `null` is legitimate — the boost window did not report a total for this
      // token — and is deliberately NOT coerced to 0.
      expect(["number", "object"]).toContain(typeof data.rows[0].boostCountTotal);
      expect(typeof data.rows[0].hasProfile).toBe("boolean");
    }
  });

  it("dexscreener.ads returns the envelope and rows against the LIVE feed", async () => {
    const result = await DEXSCREENER_HANDLERS["dexscreener.ads"]!({}, READ_CTX);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(typeof data.returned).toBe("number");
    expect(Array.isArray(data.rows)).toBe(true);
    expect(typeof data.rows[0].adType).toBe("string");
  });
});

// ── Deterministic sort / limit / projection (no live network) ──────
//
// These spy on the shared singleton client (`getDexScreenerClient()`) so the
// handler's sort/limit/projection logic is exercised against crafted fixtures
// instead of `https://api.dexscreener.com`. Spies are restored after each test
// so the live-network integration tests above stay untouched.

const PERM = { sessionPermission: "restricted" as const, approved: false };

/**
 * Resolve a handler without a non-null assertion.
 *
 * The older call sites in this file index the map with `!`; new ones use this so
 * a missing handler fails with the toolId instead of a `TypeError` on undefined.
 */
function handlerFor(toolId: string): ProtocolHandler {
  const handler = DEXSCREENER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`no handler for ${toolId}`);
  return handler;
}

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
      { chain: "solana", tokenAddress: "TOKEN" },
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
      { chain: "solana", tokenAddress: "TOKEN" },
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
      { chain: "solana", tokenAddress: "TOKEN", limit: 2 },
      PERM,
    );
    const data = JSON.parse(result.output);
    expect(data.returned).toBe(2);
    // `totalMatched` still reports all three, so the window is visible rather
    // than being the only number the agent sees.
    expect(data.totalMatched).toBe(3);
    expect(data.hasMore).toBe(true);
    expect(data.pairs.map((x: { dexId: string }) => x.dexId)).toEqual(["b", "c"]);
  });

  it("returns all pairs (no truncation) when limit is omitted", async () => {
    const client = getDexScreenerClient();
    const pairs: DexPair[] = Array.from({ length: 30 }, (_, i) =>
      makePair({ dexId: `dex${i}`, liquidity: { usd: i, base: 1, quote: 1 } }),
    );
    vi.spyOn(client, "getTokenPairs").mockResolvedValue(pairs);

    const result = await DEXSCREENER_HANDLERS["dexscreener.tokenPairs"]!(
      { chain: "solana", tokenAddress: "TOKEN" },
      PERM,
    );
    const data = JSON.parse(result.output);
    expect(data.returned).toBe(30);
    expect(data.hasMore).toBe(false);
  });

  it("projects pairs to the AgentDexPair lean row — units in every name, raw noise gone", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getTokenPairs").mockResolvedValue([
      makePair({
        chainId: "ethereum",
        dexId: "uniswap",
        labels: ["v3"],
        priceNative: "0.002",
        liquidity: { usd: 1000, base: 1, quote: 2 },
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
      { chain: "ethereum", tokenAddress: "TOKEN" },
      PERM,
    );
    const data = JSON.parse(result.output);
    const pair = data.pairs[0];

    // LEAN SET — identity, price, depth, and the two numbers Vex derives.
    expect(pair.chainId).toBe("ethereum");
    expect(pair.dexId).toBe("uniswap");
    expect(pair.pairAddress).toBe("PAIRabc"); // load-bearing for the zap pool-address workflow
    expect(pair.baseAddress).toBe("BASE");
    expect(pair.baseSymbol).toBe("BASE");
    expect(pair.quoteSymbol).toBe("QUOTE");
    expect(pair.priceUsd).toBe("3.14");
    expect(pair.liquidityUsd).toBe(1000);
    expect(pair.volumeUsdSelected).toBe(5000);
    expect(pair.priceChangePctSelected).toBe(-2);
    // volumeUsdH24 / liquidityUsd = 5000 / 1000 — computed by us, and the
    // cheapest defence this API affords against fabricated depth.
    expect(pair.turnoverRatioH24).toBe(5);
    expect(typeof pair.pairAgeSeconds).toBe("number");
    expect(pair.labels).toEqual(["v3"]);

    // NOT in the lean projection — the unit-less predecessors are gone entirely,
    // and the rest are opt-in via `fields`.
    expect(pair.baseToken).toBeUndefined();
    expect(pair.quoteToken).toBeUndefined();
    expect(pair.priceNative).toBeUndefined();
    expect(pair.fdv).toBeUndefined();
    expect(pair.marketCap).toBeUndefined();
    expect(pair.volumeH24).toBeUndefined();
    expect(pair.priceChangeH24).toBeUndefined();
    expect(pair.txnsH24).toBeUndefined();
    expect(pair.pairCreatedAt).toBeUndefined();
    expect(pair.baseName).toBeUndefined();
    expect(pair.fdvUsd).toBeUndefined();
    expect(pair.info).toBeUndefined();
    expect(pair.url).toBeUndefined();
    expect(pair.boosts).toBeUndefined();
  });

  it("emits the rich fields on request, including the fake-depth detectors", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getTokenPairs").mockResolvedValue([
      makePair({
        liquidity: { usd: 1_000_000, base: 3_374_934, quote: 13.504 },
        fdv: 500,
        marketCap: 500,
        priceNative: "1892.5670",
      }),
    ]);

    const result = await handlerFor("dexscreener.tokenPairs")(
      {
        chain: "solana",
        tokenAddress: "TOKEN",
        fields: "liquidityBaseTokens,liquidityQuoteTokens,marketCapEqualsFdv,priceInQuoteToken,decimalsAvailable",
      },
      PERM,
    );
    const data = JSON.parse(result.output);
    const pair = data.pairs[0];

    // The pair reports $1M of USD liquidity against 13.5 quote tokens. Both
    // numbers were parsed and then deleted by the predecessor, so the agent had
    // no way to see the contradiction.
    expect(pair.liquidityBaseTokens).toBe(3_374_934);
    expect(pair.liquidityQuoteTokens).toBe(13.504);
    // marketCap === fdv means circulating supply is UNKNOWN, not "no dilution".
    expect(pair.marketCapEqualsFdv).toBe(true);
    // Renamed from `priceNative`, which reads as the chain's gas token and is not.
    expect(pair.priceInQuoteToken).toBe("1892.5670");
    expect(pair.decimalsAvailable).toBe(false);
    // …and the payload names the resolver, because DexScreener sends no decimals.
    expect(data.tokenDecimalsNote).toContain("khalani.tokens.search");
  });
});

/** Wrap crafted boost rows in the feed envelope the client now returns. */
function feedOf(boosts: DexBoost[]): DexBoostFeed {
  return { boosts, skipped: 0 };
}

// The silent `limit = 20` default is GONE. It sliced a 54-row merge down to 20
// with no flag and no count of what it cut, which is the pattern
// `agents_dm/agentscan-phase4/README.md`'s OWNER RULE forbids outright.
describe("dexscreener.attention has no hidden limit", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function boostRows(count: number): DexBoost[] {
    return Array.from({ length: count }, (_, i) => ({
      url: `https://dexscreener.com/solana/t${i}`,
      chainId: "solana",
      tokenAddress: `TOKEN${i}`,
      amount: count - i,
      totalAmount: count - i,
      icon: null,
      header: null,
      description: null,
      links: null,
    }));
  }

  it("returns all 25 merged rows when limit is omitted, where it used to return 20", async () => {
    const client = getDexScreenerClient();
    const profiles: DexTokenProfile[] = [];
    vi.spyOn(client, "getBoosts").mockResolvedValue(feedOf(boostRows(25)));
    vi.spyOn(client, "getProfiles").mockResolvedValue(profiles);

    const result = await DEXSCREENER_HANDLERS["dexscreener.attention"]!({}, PERM);
    expect(result.success).toBe(true);
    const data = JSON.parse(result.output);
    expect(data.returned).toBe(25);
    expect(data.rows.length).toBe(25);
    expect(data.hasMore).toBe(false);
  });

  it("applies an explicit limit and says how many were left behind", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "getBoosts").mockResolvedValue(feedOf(boostRows(25)));
    vi.spyOn(client, "getProfiles").mockResolvedValue([]);

    const result = await DEXSCREENER_HANDLERS["dexscreener.attention"]!({ limit: 5 }, PERM);
    const data = JSON.parse(result.output);
    expect(data.returned).toBe(5);
    // The count the old shape could not express: 25 matched, 5 delivered.
    expect(data.totalMatched).toBe(25);
    expect(data.hasMore).toBe(true);
  });
});

// ── Search client-side filters (chainIds / minLiquidityUsd / limit) ─

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

  it("filters by chainIds and echoes the identifier NORMALISED, not as typed", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: searchPairs() });

    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "xx", chainIds: "BASE" },
      PERM,
    );
    const data = JSON.parse(result.output);
    // The predecessor echoed `chainId: "BASE"` while every row it returned said
    // `"base"`, so the echo disagreed with the data it described.
    expect(data.chainIds).toEqual(["base"]);
    expect(data.pairs.every((pr: { chainId: string }) => pr.chainId === "base")).toBe(true);
    // Provider order preserved: `search` no longer re-ranks a relevance sample.
    expect(data.pairs.map((pr: { dexId: string }) => pr.dexId)).toEqual(["a", "c"]);
    expect(data.droppedByFilter).toEqual({ chainIds: 2 });
  });

  it("filters by minLiquidityUsd and accounts for every dropped row", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: searchPairs() });

    const result = await DEXSCREENER_HANDLERS["dexscreener.search"]!(
      { query: "xx", minLiquidityUsd: 10000, sortBy: "liquidityUsd" },
      PERM,
    );
    const data = JSON.parse(result.output);
    // Only base@100k and solana@900k clear the 10k floor; sorted desc on request.
    expect(data.pairs.map((pr: { dexId: string }) => pr.dexId)).toEqual(["d", "a"]);
    expect(data.totalMatched).toBe(2);
    expect(data.droppedByFilter).toEqual({ minLiquidityUsd: 2 });
    expect(data.returned + 2).toBe(data.providerWindow.providerReturned);
  });

  it("has NO default limit — every provider row is returned unless the agent asks otherwise", async () => {
    const client = getDexScreenerClient();
    const many: DexPair[] = Array.from({ length: 30 }, (_, i) =>
      makePair({ chainId: "base", dexId: `d${i}`, liquidity: { usd: 30 - i, base: 1, quote: 1 } }),
    );
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: many });

    // The predecessor's `SEARCH_DEFAULT_LIMIT = 20` dropped rows 21-30 of a
    // 30-row provider window with no flag and no count of what was cut.
    const def = JSON.parse(
      (await handlerFor("dexscreener.search")({ query: "xx" }, PERM)).output,
    );
    expect(def.returned).toBe(30);
    expect(def.hasMore).toBe(false);

    const capped = JSON.parse(
      (await handlerFor("dexscreener.search")({ query: "xx", limit: 3 }, PERM)).output,
    );
    expect(capped.returned).toBe(3);
    expect(capped.totalMatched).toBe(30);
    expect(capped.hasMore).toBe(true);
  });

  it("preserves provider order by default and re-orders only when asked", async () => {
    const client = getDexScreenerClient();
    vi.spyOn(client, "search").mockResolvedValue({ schemaVersion: "1", pairs: searchPairs() });

    const asReturned = JSON.parse(
      (await handlerFor("dexscreener.search")({ query: "xx" }, PERM)).output,
    );
    expect(asReturned.pairs.map((pr: { dexId: string }) => pr.dexId)).toEqual(["a", "b", "c", "d"]);
    expect(asReturned.filtersApplied.sortBy).toBe("relevance");

    const byDepth = JSON.parse(
      (
        await handlerFor("dexscreener.search")(
          { query: "xx", sortBy: "liquidityUsd" },
          PERM,
        )
      ).output,
    );
    expect(byDepth.pairs.map((pr: { dexId: string }) => pr.dexId)).toEqual(["d", "a", "b", "c"]);
  });

  it("refuses a 1-character query instead of surfacing an unexplained HTTP 400", async () => {
    const result = await handlerFor("dexscreener.search")({ query: "a" }, PERM);
    expect(result.success).toBe(false);
    expect(result.output).toContain("2 characters");
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
    expect(data.returned).toBe(3);
    // Provider order is preserved by default: DexScreener's narrative order is
    // undisclosed, so re-ranking it and calling the result "trending" would invent
    // a ranking. `m0` is first because it was sent first.
    expect(data.narratives[0].slug).toBe("m0");
    expect(data.filtersApplied.sortBy).toBe("relevance");
    expect(data.totalMatched).toBe(5);
    expect(data.hasMore).toBe(true);
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
    // THREE distinct numbers replace two that could be confused. `tokenCount` and
    // `marketCap` are gone as names: measured live, this endpoint's `marketCap` is
    // exactly the sum of the pairs it returns and its `tokenCount` is exactly how
    // many it returns, while the trending feed reported more than twice as many
    // tokens for the same slug in the same minute.
    expect(data.narrativeSubsetTokenCount).toBe(2);
    expect(data.pairsReturned).toBe(1);
    expect(data.subsetMarketCapSumUsd).toBe(123);
    expect(data.tokenCount).toBeUndefined();
    expect(data.marketCap).toBeUndefined();
    expect(data.pairCount).toBeUndefined();
    expect(data.narrativeSubsetNote).toContain("dexscreener.trending");
    // Pairs are AgentDexPair rows now — `projectors.ts` is deleted.
    expect(data.pairs[0].liquidityUsd).toBe(10);
    expect(data.pairs[0].turnoverRatioH24).toBeDefined();
    expect(data.pairs[0].url).toBeUndefined();
    expect(data.pairs[0].priceNative).toBeUndefined();
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
    expect(okResult.returned).toBe(1);
    expect(okResult.rows[0].updatedAt).toBe("2026-07-04T00:00:00.000Z");
    expect(okResult.rows[0].communityTakeover).toBe(false);
    expect(okResult.available).toBeUndefined();

    const boom = new Error("boom");
    vi.spyOn(client, "getProfilesRecentUpdates").mockRejectedValue(boom);
    await expect(DEXSCREENER_HANDLERS["dexscreener.profiles.recent"]!({}, PERM)).rejects.toBe(boom);
  });
});
