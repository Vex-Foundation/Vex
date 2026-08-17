/**
 * Morpho handler behaviour: the agent-facing contract.
 *
 * Four properties are asserted because each of them is a rule the fleet has
 * broken before:
 *   - every filter is ECHOED in `filtersApplied` (rules/90: a silently dropped
 *     parameter is forbidden);
 *   - an off-enum or out-of-range value is REJECTED BY NAME, never clamped;
 *   - a raw amount never appears without its decimals and an exact human
 *     rendering (rules/90: raw amounts travel with the scale needed to read them);
 *   - APY fields carry their basis, and base is never emitted under a net name.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { morphoMarketsDiscover } from "../../../../../vex-agent/tools/protocols/morpho/handlers/markets-discover.js";
import { morphoMarketGet } from "../../../../../vex-agent/tools/protocols/morpho/handlers/market-get.js";
import { formatRawAmount } from "../../../../../vex-agent/tools/protocols/morpho/projectors.js";
import { MORPHO_MARKETS_PAGE, MORPHO_MARKET_DETAIL, MORPHO_MARKETS_UNLISTED } from "./fixtures.js";

/**
 * A REAL `Response`. The Morpho client reads `ok`, `status`,
 * `headers.get("retry-after")` and `json()`; a hand-shaped double answers
 * exactly those and would keep passing if the client started reading a fifth.
 */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Capture the GraphQL variables the handler ultimately sent. */
function stubMorpho(body: unknown): { calls: Array<Record<string, unknown>> } {
  const calls: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return jsonResponse(body);
    }),
  );
  return { calls };
}

function data(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

beforeEach(() => {
  // The client singleton caches per endpoint AND caches responses per query, so
  // each test varies its own params to avoid a cross-test cache hit.
  vi.resetModules();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("formatRawAmount", () => {
  it("renders base units exactly, without touching floating point", () => {
    expect(formatRawAmount("1483209486620379", 6)).toBe("1483209486.620379");
    expect(formatRawAmount("355405952890211270375830324", 18)).toBe("355405952.890211270375830324");
    expect(formatRawAmount("1047061", 6)).toBe("1.047061");
    expect(formatRawAmount("1047061", 9)).toBe("0.001047061");
    expect(formatRawAmount("0", 18)).toBe("0");
    expect(formatRawAmount("500", 0)).toBe("500");
  });
});

describe("morpho.markets.discover", () => {
  it("echoes every applied filter, including the defaults it chose", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({
      chainIds: "base,ethereum",
      minSupplyUsd: 1_000_000,
      maxLltvPercent: 90,
      sort: "netSupplyApy",
      order: "asc",
      limit: 3,
    });
    const applied = data(result)["filtersApplied"] as Record<string, unknown>;
    expect(applied["chainIds"]).toEqual(["8453", "1"]);
    expect(applied["minSupplyUsd"]).toBe(1_000_000);
    expect(applied["maxLltvPercent"]).toBe(90);
    expect(applied["sort"]).toBe("netSupplyApy");
    expect(applied["order"]).toBe("asc");
    // A default the caller did not name is still echoed - it was applied.
    expect(applied["listedOnly"]).toBe(true);
  });

  it("translates percent params into the fractions and WAD integers Morpho expects", async () => {
    const { calls } = stubMorpho(MORPHO_MARKETS_PAGE);
    await morphoMarketsDiscover({ minUtilizationPercent: 80, minNetSupplyApyPercent: 5, minLltvPercent: 86, limit: 4 });
    const where = (calls[0]?.["variables"] as Record<string, Record<string, unknown>>)["where"];
    expect(where?.["utilization_gte"]).toBe(0.8);
    expect(where?.["netSupplyApy_gte"]).toBe(0.05);
    expect(where?.["lltv_gte"]).toBe("860000000000000000");
  });

  it("REJECTS an off-enum sort by name, listing what would have been accepted", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ sort: "yield" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("`sort` must be one of");
    expect(result.output).toContain("netSupplyApy");
    expect(result.output).toContain('Received "yield"');
  });

  it("REJECTS an over-limit page rather than clamping it silently", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ limit: 500 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("`limit` must be at most 50");
    expect(result.output).toContain("rather than clamping");
  });

  it("REJECTS an unsupported chain by name, distinguishing coverage from absence", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const katana = await morphoMarketsDiscover({ chainIds: "747474" });
    expect(katana.success).toBe(false);
    expect(katana.output).toContain("Morpho serves Katana");
    expect(katana.output).toContain("Vex does not operate on that chain");

    const nonsense = await morphoMarketsDiscover({ chainIds: "solana" });
    expect(nonsense.success).toBe(false);
    expect(nonsense.output).toContain("not a Morpho chain Vex reads");
  });

  it("REJECTS a floor above its ceiling instead of returning an empty result", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ minSupplyUsd: 100, maxSupplyUsd: 10 });
    expect(result.success).toBe(false);
    expect(result.output).toContain("so nothing can match");
  });

  it("REJECTS a symbol where an address belongs", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ loanTokenAddress: "USDC" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("not a 0x-prefixed 40-hex EVM address");
  });

  it("ships every raw amount with its decimals, symbol and an exact human rendering", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ limit: 5 });
    const markets = data(result)["markets"] as Array<Record<string, Record<string, unknown>>>;
    const supply = markets[0]?.["supply"];
    expect(supply?.["raw"]).toBe("1483209486620379");
    expect(supply?.["decimals"]).toBe(6);
    expect(supply?.["symbol"]).toBe("USDC");
    expect(supply?.["human"]).toBe("1483209486.620379");
    // Collateral uses the COLLATERAL asset's scale, never the loan asset's.
    expect(markets[0]?.["collateral"]?.["decimals"]).toBe(8);
  });

  it("labels APY by basis and never emits a base figure under a net name", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ limit: 6 });
    const markets = data(result)["markets"] as Array<Record<string, Record<string, unknown>>>;
    const apy = markets[0]?.["apy"];
    expect(apy?.["supplyApyPercent"]).toBeCloseTo(4.120798108290647, 9);
    expect(apy?.["netSupplyApyPercent"]).toBeCloseTo(4.120798108290647, 9);
    expect(apy?.["borrowApyPercent"]).toBeDefined();
    expect(apy?.["netBorrowApyPercent"]).toBeDefined();
    expect(String(apy?.["basis"])).toContain("EXCLUDE incentives");
    expect(String(apy?.["basis"])).toContain("INCLUDE them");
    expect(apy?.["rewards"]).toEqual([]);
  });

  it("reports pagination honestly from Morpho's own match count", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ limit: 7, offset: 0 });
    const body = data(result);
    expect(body["matched"]).toBe(395);
    expect(body["returned"]).toBe(3);
    expect(body["hasMore"]).toBe(true);
    expect(body["nextOffset"]).toBe(3);
  });

  it("names the permissionless hazard when listedOnly is turned off", async () => {
    stubMorpho(MORPHO_MARKETS_UNLISTED);
    const result = await morphoMarketsDiscover({ listedOnly: false, sort: "netSupplyApy", limit: 2 });
    const body = data(result);
    expect(String((body["notes"] as Record<string, unknown>)["listed"])).toContain("UNLISTED markets are included");
    expect(String(body["summary"])).toContain("INCLUDING permissionless unlisted markets");
    const markets = body["markets"] as Array<Record<string, unknown>>;
    // The dust market's warnings reach the agent verbatim, next to its APY.
    expect(JSON.stringify(markets[0]?.["warnings"])).toContain("sustained_low_liquidity");
  });

  it("keeps only the requested field groups", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ fields: "identity,apy", limit: 8 });
    const markets = data(result)["markets"] as Array<Record<string, unknown>>;
    expect(markets[0]).toHaveProperty("apy");
    expect(markets[0]).toHaveProperty("lltvPercent");
    expect(markets[0]).not.toHaveProperty("supply");
    expect(markets[0]).toHaveProperty("marketId");
  });

  it("REJECTS an unknown field group by name", async () => {
    stubMorpho(MORPHO_MARKETS_PAGE);
    const result = await morphoMarketsDiscover({ fields: "identity,everything" });
    expect(result.success).toBe(false);
    expect(result.output).toContain('`fields` contains "everything"');
  });
});

describe("morpho.market.get", () => {
  const base = {
    marketId: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
    chain: "base",
  };

  it("requires both marketId and chain, and says why", async () => {
    stubMorpho(MORPHO_MARKET_DETAIL);
    const noChain = await morphoMarketGet({ marketId: base.marketId });
    expect(noChain.success).toBe(false);
    expect(noChain.output).toContain("`chain` is required");
    expect(noChain.output).toContain("chain-scoped");

    const noId = await morphoMarketGet({ chain: "base" });
    expect(noId.success).toBe(false);
    expect(noId.output).toContain("`marketId` is required");
  });

  it("REJECTS a contract address in marketId, naming what it actually is", async () => {
    stubMorpho(MORPHO_MARKET_DETAIL);
    const result = await morphoMarketGet({ marketId: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("20-byte contract ADDRESS");
  });

  it("returns bad debt, the oracle price with its scale, and per-vault shared liquidity", async () => {
    stubMorpho(MORPHO_MARKET_DETAIL);
    const result = await morphoMarketGet({ ...base });
    const market = data(result)["market"] as Record<string, Record<string, unknown>>;

    const badDebt = market["badDebt"];
    expect((badDebt?.["outstanding"] as Record<string, unknown>)["decimals"]).toBe(6);
    expect(String(badDebt?.["note"])).toContain("socialised across");

    const oracle = market["oraclePrice"] as Record<string, unknown>;
    expect(oracle["scaleDecimals"]).toBe(34);
    // 6.2746442e38 at scale 34 is 62,746.44 - the cbBTC price the same response
    // reports as 62,686 USD. That agreement is what pins the scale formula.
    expect(oracle["human"]).toBe("62746.442");

    const liquidity = market["liquidity"] as Record<string, unknown>;
    const perVault = liquidity["publicAllocatorByVault"] as Array<Record<string, unknown>>;
    expect(perVault.length).toBeLessThan(22);
    expect((perVault[0]?.["assets"] as Record<string, unknown>)["decimals"]).toBe(6);
    expect(String(liquidity["note"])).toContain("not committed");
  });

  it("adds the averaged window only when asked, labelled with its basis", async () => {
    stubMorpho(MORPHO_MARKET_DETAIL);
    const without = await morphoMarketGet({ ...base });
    expect((data(without)["market"] as Record<string, unknown>)["apyWindow"]).toBeNull();

    const with_ = await morphoMarketGet({ ...base, includeHistory: true, lookback: "thirty_days" });
    const window = (data(with_)["market"] as Record<string, Record<string, unknown>>)["apyWindow"];
    expect(window?.["lookback"]).toBe("thirty_days");
    expect(window?.["supplyApyPercent"]).toBeCloseTo(4.4847218661766775, 9);
    expect(String(window?.["basis"])).toContain("EXCLUDE incentives");
  });

  it("REJECTS an off-enum lookback by name", async () => {
    stubMorpho(MORPHO_MARKET_DETAIL);
    const result = await morphoMarketGet({ ...base, includeHistory: true, lookback: "six_months" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("`lookback` must be one of");
    expect(result.output).toContain("ninety_days");
  });

  it("warns that a vault APY is a different basis from a market APY", async () => {
    stubMorpho(MORPHO_MARKET_DETAIL);
    const result = await morphoMarketGet({ ...base, includeSupplyingVaults: true });
    const vaults = (data(result)["market"] as Record<string, Record<string, unknown>>)["supplyingVaults"];
    expect(String(vaults?.["note"])).toContain("NET of the vault's fee");
    expect((vaults?.["vaults"] as unknown[]).length).toBeGreaterThan(0);
  });

  it("surfaces a Morpho refusal with its code, status and remediation", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ errors: [{ message: 'Cannot query field "priceUsd" on type "Asset".' }] }, 400)),
    );
    // A distinct market id, so the client's short TTL cache cannot serve an
    // earlier test's successful body in place of this refusal.
    const result = await morphoMarketGet({
      marketId: "0x54cf9be57fdfa6457a660991907434ff9d295c465a603a50126ff647d50b7354",
      chain: "base",
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain("morpho.market.get failed");
    expect(result.output).toContain("MORPHO_API_ERROR/provider_refusal");
    expect(result.output).toContain("HTTP 400");
    expect(result.output).toContain('Cannot query field "priceUsd"');
    expect(result.output).not.toMatch(/unexpected error/i);
  });
});
