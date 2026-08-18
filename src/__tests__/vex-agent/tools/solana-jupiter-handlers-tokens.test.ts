import { describe, it, expect, vi, beforeEach } from "vitest";

import { ctx } from "./_solana-jupiter-handlers-context.js";

// Mock the Jupiter tokens service so category-routing tests never hit the
// network and we can assert WHICH provider a category routes to. `vi.hoisted`
// is required because the `vi.mock` factory is hoisted above top-level imports.
const {
  getJupiterTokensByCategory,
  getJupiterRecentTokens,
  getJupiterTokensByTag,
  searchJupiterTokens,
} = vi.hoisted(() => ({
  // Explicit element type: a bare `async () => []` infers `never[]`, which
  // rejects every mockResolvedValueOnce that feeds a token fixture.
  getJupiterTokensByCategory: vi.fn(async (): Promise<unknown[]> => []),
  getJupiterRecentTokens: vi.fn(async (): Promise<unknown[]> => []),
  getJupiterTokensByTag: vi.fn(async (): Promise<unknown[]> => []),
  searchJupiterTokens: vi.fn(async (): Promise<unknown[]> => []),
}));

vi.mock("@tools/solana-ecosystem/jupiter/jupiter-tokens/service.js", () => ({
  getJupiterTokensByCategory,
  getJupiterRecentTokens,
  getJupiterTokensByTag,
  searchJupiterTokens,
}));

import { SOLANA_JUPITER_HANDLERS } from "../../../vex-agent/tools/protocols/solana-jupiter/handlers.js";

// Tokens-domain slice of the original combined solana-jupiter-handlers.test.ts
// (search param validation + trending category/interval routing).
describe("solana-jupiter handlers — tokens", () => {
  it("solana.tokens.search fails without query", async () => {
    const result = await SOLANA_JUPITER_HANDLERS["solana.tokens.search"]!(
      {},
      ctx(),
    );
    expect(result.success).toBe(false);
    expect(result.output).toContain("query");
  });

  // ── solana.tokens.trending — category/interval routing & guards ──

  const trending = (p: Record<string, unknown>) =>
    SOLANA_JUPITER_HANDLERS["solana.tokens.trending"]!(p, ctx());

  beforeEach(() => {
    getJupiterTokensByCategory.mockClear();
    getJupiterRecentTokens.mockClear();
    getJupiterTokensByTag.mockClear();
  });

  it("solana.tokens.trending rejects a present-but-unknown category", async () => {
    const result = await trending({ category: "hot" });
    expect(result.success).toBe(false);
    for (const valid of ["toptrending", "toptraded", "toporganicscore", "recent", "lst", "verified"]) {
      expect(result.output).toContain(valid);
    }
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
    expect(getJupiterRecentTokens).not.toHaveBeenCalled();
    expect(getJupiterTokensByTag).not.toHaveBeenCalled();
  });

  // Codex BLOCKER regression: a prototype key must NOT pass membership and must
  // NOT route to any provider (previously `"constructor" in TAG_MAP` was true).
  it("solana.tokens.trending rejects prototype keys (constructor / toString)", async () => {
    for (const proto of ["constructor", "toString", "hasOwnProperty"]) {
      const result = await trending({ category: proto });
      expect(result.success).toBe(false);
      expect(result.output).toContain("Unknown category");
    }
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
    expect(getJupiterRecentTokens).not.toHaveBeenCalled();
    expect(getJupiterTokensByTag).not.toHaveBeenCalled();
  });

  it("solana.tokens.trending rejects a present-but-unknown interval", async () => {
    const result = await trending({ interval: "4h" });
    expect(result.success).toBe(false);
    for (const valid of ["5m", "1h", "6h", "24h"]) {
      expect(result.output).toContain(valid);
    }
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
  });

  it("solana.tokens.trending defaults absent category/interval to toptrending/1h via category provider", async () => {
    const result = await trending({});
    expect(result.success).toBe(true);
    expect(getJupiterTokensByCategory).toHaveBeenCalledTimes(1);
    expect(getJupiterTokensByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ category: "toptrending", interval: "1h" }),
    );
    expect(getJupiterRecentTokens).not.toHaveBeenCalled();
    expect(getJupiterTokensByTag).not.toHaveBeenCalled();
  });

  it("solana.tokens.trending routes 'recent' to the recent provider", async () => {
    const result = await trending({ category: "recent" });
    expect(result.success).toBe(true);
    expect(getJupiterRecentTokens).toHaveBeenCalledTimes(1);
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
    expect(getJupiterTokensByTag).not.toHaveBeenCalled();
  });

  it("recent applies the advertised limit as a VISIBLE window, never silently", async () => {
    // The pre-fix branch ignored `limit` entirely: a bare live call returned 30
    // rows measuring 27,970 B against the 16,384 B tool-output cap.
    getJupiterRecentTokens.mockResolvedValueOnce(
      Array.from({ length: 30 }, (_, i) => ({
        id: `mint-${i}`,
        name: `Token ${i}`,
        symbol: `T${i}`,
        decimals: 9,
      })),
    );
    const result = await trending({ category: "recent", limit: 5 });
    expect(result.success).toBe(true);
    const data = result.data as unknown as {
      returned: number;
      totalMatched: number;
      hasMore: boolean;
      tokens: { mint: string }[];
    };
    expect(data.returned).toBe(5);
    expect(data.totalMatched).toBe(30);
    expect(data.hasMore).toBe(true);
    expect(data.tokens).toHaveLength(5);
    expect(data.tokens[0]!.mint).toBe("mint-0");
  });

  it("solana.tokens.trending routes 'lst' and 'verified' to the tag provider", async () => {
    for (const tag of ["lst", "verified"] as const) {
      getJupiterTokensByTag.mockClear();
      const result = await trending({ category: tag });
      expect(result.success).toBe(true);
      expect(getJupiterTokensByTag).toHaveBeenCalledTimes(1);
      expect(getJupiterTokensByTag).toHaveBeenCalledWith(tag);
    }
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
    expect(getJupiterRecentTokens).not.toHaveBeenCalled();
  });

  it("solana.tokens.trending routes 'toptraded' to the category provider", async () => {
    const result = await trending({ category: "toptraded" });
    expect(result.success).toBe(true);
    expect(getJupiterTokensByCategory).toHaveBeenCalledTimes(1);
    expect(getJupiterTokensByCategory).toHaveBeenCalledWith(
      expect.objectContaining({ category: "toptraded" }),
    );
    expect(getJupiterTokensByTag).not.toHaveBeenCalled();
    expect(getJupiterRecentTokens).not.toHaveBeenCalled();
  });

  // W1-G: "stocks" (tokenized equities) was previously unmodeled/rejected.
  it("solana.tokens.trending routes 'stocks' to the tag provider", async () => {
    const result = await trending({ category: "stocks" });
    expect(result.success).toBe(true);
    expect(getJupiterTokensByTag).toHaveBeenCalledTimes(1);
    expect(getJupiterTokensByTag).toHaveBeenCalledWith("stocks");
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
    expect(getJupiterRecentTokens).not.toHaveBeenCalled();
  });
});

// W1-G — statsInterval selector + client-side threshold filters, shared by
// solana.tokens.search and solana.tokens.trending.
describe("solana-jupiter handlers — tokens output redesign (W1-G)", () => {
  const trending = (p: Record<string, unknown>) =>
    SOLANA_JUPITER_HANDLERS["solana.tokens.trending"]!(p, ctx());
  const search = (p: Record<string, unknown>) =>
    SOLANA_JUPITER_HANDLERS["solana.tokens.search"]!(p, ctx());

  /** A token with all four stats windows populated, plus safety/liquidity signals. */
  function rawToken(overrides: Record<string, unknown> = {}) {
    return {
      id: "So11111111111111111111111111111111111111112",
      name: "Wrapped SOL",
      symbol: "SOL",
      decimals: 9,
      organicScore: 90,
      isVerified: true,
      liquidity: 1_000_000,
      stats5m: { priceChange: 0.1 },
      stats1h: { priceChange: 1.2 },
      stats6h: { priceChange: -0.5 },
      stats24h: { priceChange: 3.4 },
      ...overrides,
    };
  }

  beforeEach(() => {
    getJupiterTokensByCategory.mockClear();
    getJupiterRecentTokens.mockClear();
    getJupiterTokensByTag.mockClear();
    searchJupiterTokens.mockClear();
  });

  // ── statsInterval ──────────────────────────────────────────────

  it("solana.tokens.trending defaults statsInterval to the resolved interval", async () => {
    getJupiterTokensByCategory.mockResolvedValueOnce([rawToken()]);
    const result = await trending({ category: "toptrending", interval: "6h" });
    expect(result.success).toBe(true);
    const tokens = (result.data as unknown as { tokens: { stats6h: unknown; stats1h: unknown }[] }).tokens;
    expect(tokens[0]!.stats6h).not.toBeNull();
    expect(tokens[0]!.stats1h).toBeNull();
  });

  it("solana.tokens.trending honors an explicit statsInterval over the resolved interval", async () => {
    getJupiterTokensByCategory.mockResolvedValueOnce([rawToken()]);
    const result = await trending({ category: "toptrending", interval: "6h", statsInterval: "24h" });
    const tokens = (result.data as unknown as { tokens: { stats6h: unknown; stats24h: unknown }[] }).tokens;
    expect(tokens[0]!.stats24h).not.toBeNull();
    expect(tokens[0]!.stats6h).toBeNull();
  });

  it("solana.tokens.trending 'all' keeps every stats window", async () => {
    getJupiterTokensByCategory.mockResolvedValueOnce([rawToken()]);
    const result = await trending({ category: "toptrending", statsInterval: "all" });
    const tokens = (result.data as unknown as { tokens: { stats5m: unknown; stats1h: unknown; stats6h: unknown; stats24h: unknown }[] }).tokens;
    expect(tokens[0]!.stats5m).not.toBeNull();
    expect(tokens[0]!.stats1h).not.toBeNull();
    expect(tokens[0]!.stats6h).not.toBeNull();
    expect(tokens[0]!.stats24h).not.toBeNull();
  });

  it("solana.tokens.trending rejects an unknown statsInterval", async () => {
    const result = await trending({ statsInterval: "3h" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("statsInterval");
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
  });

  it("solana.tokens.search defaults statsInterval to 1h", async () => {
    searchJupiterTokens.mockResolvedValueOnce([rawToken()]);
    const result = await search({ query: "SOL" });
    const tokens = result.data as unknown as { stats1h: unknown; stats24h: unknown }[];
    expect(tokens[0]!.stats1h).not.toBeNull();
    expect(tokens[0]!.stats24h).toBeNull();
  });

  it("solana.tokens.search honors an explicit statsInterval", async () => {
    searchJupiterTokens.mockResolvedValueOnce([rawToken()]);
    const result = await search({ query: "SOL", statsInterval: "5m" });
    const tokens = result.data as unknown as { stats5m: unknown; stats1h: unknown }[];
    expect(tokens[0]!.stats5m).not.toBeNull();
    expect(tokens[0]!.stats1h).toBeNull();
  });

  it("solana.tokens.search rejects an unknown statsInterval", async () => {
    const result = await search({ query: "SOL", statsInterval: "bogus" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("statsInterval");
    expect(searchJupiterTokens).not.toHaveBeenCalled();
  });

  // ── Threshold filters ────────────────────────────────────────────

  it("solana.tokens.trending applies minOrganicScore/verifiedOnly/minLiquidity before projection", async () => {
    getJupiterTokensByCategory.mockResolvedValueOnce([
      rawToken({ id: "Passes", organicScore: 90, isVerified: true, liquidity: 500_000 }),
      rawToken({ id: "FailsScore", organicScore: 5, isVerified: true, liquidity: 500_000 }),
      rawToken({ id: "FailsVerified", organicScore: 90, isVerified: false, liquidity: 500_000 }),
      rawToken({ id: "FailsLiquidity", organicScore: 90, isVerified: true, liquidity: 1 }),
    ]);
    const result = await trending({
      category: "toptrending",
      minOrganicScore: 50,
      verifiedOnly: true,
      minLiquidity: 10_000,
    });
    expect(result.success).toBe(true);
    const tokens = (result.data as unknown as { tokens: { mint: string }[] }).tokens;
    expect(tokens.map((t) => t.mint)).toEqual(["Passes"]);
  });

  it("solana.tokens.search applies threshold filters before projection", async () => {
    searchJupiterTokens.mockResolvedValueOnce([
      rawToken({ id: "Passes", organicScore: 90 }),
      rawToken({ id: "Fails", organicScore: 5 }),
    ]);
    const result = await search({ query: "SOL", minOrganicScore: 50 });
    const tokens = result.data as unknown as { mint: string }[];
    expect(tokens.map((t) => t.mint)).toEqual(["Passes"]);
  });

  it("solana.tokens.trending rejects an out-of-range minOrganicScore (never clamps)", async () => {
    const result = await trending({ minOrganicScore: 150 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("minOrganicScore");
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
  });

  it("solana.tokens.trending rejects a negative minLiquidity (never clamps)", async () => {
    const result = await trending({ minLiquidity: -1 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("minLiquidity");
    expect(getJupiterTokensByCategory).not.toHaveBeenCalled();
  });

  it("solana.tokens.search rejects an out-of-range minOrganicScore (never clamps)", async () => {
    const result = await search({ query: "SOL", minOrganicScore: -5 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("minOrganicScore");
    expect(searchJupiterTokens).not.toHaveBeenCalled();
  });
});
