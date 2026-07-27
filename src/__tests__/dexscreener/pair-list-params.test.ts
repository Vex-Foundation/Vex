/**
 * Param validation for the DexScreener list vocabulary.
 *
 * Every case here was a live defect. The previous readers checked
 * `typeof value === "number"` and nothing else, so:
 *
 * - `minLiquidityUsd: NaN` made every comparison false and reported an empty
 *   market as `matched: 0`;
 * - `limit: -5` fell through to a hidden default;
 * - `limit: 0` meant "20" in `search` and "everything" in three sibling handlers;
 * - `minLiquidityUsd: 0` filtered, because a null-liquidity row failed
 *   `(value ?? -Infinity) >= 0`;
 * - the `chainId` echo kept the caller's casing while every row said lowercase.
 *
 * A rejection must NAME the parameter: a silently ignored filter is
 * indistinguishable from a filter that matched nothing, and the agent cannot
 * tell which of those it is looking at.
 */

import { describe, expect, it } from "vitest";

import { parsePairListQuery } from "@vex-agent/tools/protocols/dexscreener/pair-list/index.js";

function parse(params: Record<string, unknown>) {
  return parsePairListQuery(params, { sortBy: "relevance", allowChainFilter: true });
}

function reasonFor(params: Record<string, unknown>): string {
  const parsed = parse(params);
  expect(parsed.ok, `expected rejection for ${JSON.stringify(params)}`).toBe(false);
  return parsed.ok ? "" : parsed.reason;
}

describe("pair-list param validation", () => {
  // ── Non-finite numbers ──────────────────────────────────────────

  it("rejects NaN BY NAME on every numeric param", () => {
    for (const key of ["limit", "offset", "minLiquidityUsd", "maxTurnoverRatio", "minPriceChangePct"]) {
      const reason = reasonFor({ [key]: Number.NaN });
      expect(reason).toContain(key);
      expect(reason).toContain("finite");
    }
  });

  it("rejects Infinity, which would also silently empty the set", () => {
    expect(reasonFor({ minLiquidityUsd: Number.POSITIVE_INFINITY })).toContain("minLiquidityUsd");
    expect(reasonFor({ maxFdvUsd: Number.NEGATIVE_INFINITY })).toContain("maxFdvUsd");
  });

  // ── Sign and integrality ────────────────────────────────────────

  it("rejects negatives on params whose domain has no negative meaning", () => {
    expect(reasonFor({ limit: -5 })).toContain("limit");
    expect(reasonFor({ offset: -1 })).toContain("offset");
    expect(reasonFor({ minLiquidityUsd: -1 })).toContain("minLiquidityUsd");
    expect(reasonFor({ minTurnoverRatio: -0.5 })).toContain("minTurnoverRatio");
    expect(reasonFor({ maxPairAgeSeconds: -60 })).toContain("maxPairAgeSeconds");
  });

  it("ACCEPTS negatives on price change, where a negative threshold is the whole point", () => {
    const parsed = parse({ minPriceChangePct: -20, maxPriceChangePct: -5 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.filters.minPriceChangePct).toBe(-20);
      expect(parsed.query.filters.maxPriceChangePct).toBe(-5);
    }
  });

  it("rejects `limit: 0` rather than letting it mean both 'none' and 'all'", () => {
    const reason = reasonFor({ limit: 0 });
    expect(reason).toContain("limit");
    expect(reason).toContain("at least 1");
  });

  it("rejects fractional counts and windows", () => {
    expect(reasonFor({ limit: 2.5 })).toContain("whole number");
    expect(reasonFor({ offset: 0.5 })).toContain("whole number");
    expect(reasonFor({ minTxnCount: 1.5 })).toContain("whole number");
    expect(reasonFor({ minPairAgeSeconds: 1.5 })).toContain("whole number");
  });

  it("caps `limit` so a caller cannot ask for a window that cannot exist", () => {
    expect(reasonFor({ limit: 5_000 })).toContain("at most 200");
    expect(parse({ limit: 200 }).ok).toBe(true);
  });

  it("rejects a wrong-typed numeric param instead of ignoring it", () => {
    expect(reasonFor({ minLiquidityUsd: "1000" })).toContain("must be a number");
    expect(reasonFor({ requireSocials: "yes" })).toContain("true or false");
    expect(reasonFor({ chainIds: 5 })).toContain("comma-separated");
  });

  // ── `min* = 0` semantics ───────────────────────────────────────

  it("keeps a zero `min*` floor as a no-op value rather than dropping the param", () => {
    const parsed = parse({ minLiquidityUsd: 0, minTurnoverRatio: 0 });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.filters.minLiquidityUsd).toBe(0);
      // Still echoed: the agent must see that the parameter was received.
      expect(parsed.query.filtersApplied.minLiquidityUsd).toBe(0);
    }
  });

  // ── Defaults ───────────────────────────────────────────────────

  it("has NO default limit — omitting it means every provider row", () => {
    const parsed = parse({});
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.limit).toBeNull();
      expect(parsed.query.offset).toBe(0);
    }
  });

  it("defaults the window to h24 and the sort to the tool's own default", () => {
    const relevance = parse({});
    expect(relevance.ok && relevance.query.sortBy).toBe("relevance");
    expect(relevance.ok && relevance.query.window).toBe("h24");

    const liquidity = parsePairListQuery({}, { sortBy: "liquidityUsd" });
    expect(liquidity.ok && liquidity.query.sortBy).toBe("liquidityUsd");
  });

  it("always echoes window / sortBy / sortDir, so the agent knows what it got", () => {
    const parsed = parse({});
    expect(parsed.ok && parsed.query.filtersApplied).toEqual({
      window: "h24",
      sortBy: "relevance",
      sortDir: "desc",
    });
  });

  // ── Enums and identifiers ──────────────────────────────────────

  it("rejects an unknown enum value and lists the allowed ones", () => {
    expect(reasonFor({ sortBy: "liquidity" })).toContain("liquidityUsd");
    expect(reasonFor({ window: "d1" })).toContain("h24");
    expect(reasonFor({ sortDir: "descending" })).toContain("desc");
  });

  it("accepts enum values case-insensitively", () => {
    const parsed = parse({ sortBy: "LiquidityUsd", window: "H1", sortDir: "ASC" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.sortBy).toBe("liquidityUsd");
      expect(parsed.query.window).toBe("h1");
      expect(parsed.query.sortDir).toBe("asc");
    }
  });

  it("normalises echoed identifiers to lowercase so the echo matches the rows", () => {
    const parsed = parse({ chainIds: " ETHEREUM , Base ", dexIds: "Uniswap", labels: "V3" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.filters.chainIds).toEqual(["ethereum", "base"]);
      expect(parsed.query.filters.dexIds).toEqual(["uniswap"]);
      expect(parsed.query.filters.labels).toEqual(["v3"]);
    }
  });

  it("rejects a list param that was supplied but carried no values", () => {
    expect(reasonFor({ chainIds: " , , " })).toContain("no values");
  });

  it("treats an empty string as absent, matching the runtime's own param semantics", () => {
    const parsed = parse({ chainIds: "", limit: null, minLiquidityUsd: undefined });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.filters.chainIds).toBeNull();
      expect(parsed.query.limit).toBeNull();
    }
  });

  // ── Field projection ───────────────────────────────────────────

  it("rejects an unknown `fields` name BY NAME instead of silently omitting it", () => {
    const reason = reasonFor({ fields: "liquidityQuote" });
    expect(reason).toContain("liquidityQuote");
    expect(reason).toContain("full");
  });

  it("`fields` is additive — the lean set is never projected away", () => {
    const parsed = parse({ fields: "fdvUsd" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.query.fields.has("fdvUsd")).toBe(true);
      expect(parsed.query.fields.has("chainId")).toBe(true);
      expect(parsed.query.fields.has("pairAddress")).toBe(true);
      expect(parsed.query.fields.has("baseName")).toBe(false);
    }
  });

  it("`includeAllWindows` adds every window without needing 24 field names", () => {
    const parsed = parse({ includeAllWindows: true });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      for (const field of ["volumeUsdM5", "priceChangePctH6", "txnBuyCountH1", "buySellRatioH24"]) {
        expect(parsed.query.fields.has(field), field).toBe(true);
      }
      // Not a licence to include the expensive text fields.
      expect(parsed.query.fields.has("baseName")).toBe(false);
    }
  });

  // ── chainIds scope ─────────────────────────────────────────────

  it("rejects chainIds on a single-chain tool, explaining what to use instead", () => {
    const parsed = parsePairListQuery({ chainIds: "ethereum" }, { sortBy: "liquidityUsd" });
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) {
      expect(parsed.reason).toContain("chainIds");
      expect(parsed.reason).toContain("dexscreener.search");
    }
  });

  it("does not read a single-chain tool's required `chainId` as a filter", () => {
    // On `pairs`/`tokens`/`tokenPairs`, `chainId` names the chain being queried.
    const parsed = parsePairListQuery({ chainId: "ethereum" }, { sortBy: "liquidityUsd" });
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.query.filters.chainIds).toBeNull();
  });
});
