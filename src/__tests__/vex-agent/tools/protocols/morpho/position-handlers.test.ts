/**
 * Morpho POSITION and ACTIVITY handler behaviour: the agent-facing contract.
 *
 * What is asserted here, and why each one would mislead the agent undetectably
 * if it broke:
 *   - every filter is ECHOED in `filtersApplied`;
 *   - a second wallet address is REFUSED BY NAME, not silently dropped, so the
 *     one-wallet-per-call privacy rule cannot be bypassed by accident;
 *   - an off-enum value is refused by name and names the accepted set;
 *   - the market half is a three-read UNION whose overlapping totals are
 *     reported as overlapping, and whose ordering is risk-first;
 *   - `maxHealthFactor` switches to the single server-paged read;
 *   - the V2 sweep reports its coverage rather than implying totality;
 *   - a raw amount never appears without decimals and an exact human rendering;
 *   - the health factor survives as a decimal string with its band, and its
 *     absence is banded `no_debt` rather than rendered as safety.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { morphoPositionsGet } from "../../../../../vex-agent/tools/protocols/morpho/handlers/positions-get.js";
import { morphoMarketsActivity } from "../../../../../vex-agent/tools/protocols/morpho/handlers/markets-activity.js";
import { formatRawAmount } from "../../../../../vex-agent/tools/protocols/morpho/projectors.js";
import { healthFactorBand } from "../../../../../vex-agent/tools/protocols/morpho/projectors/positions.js";
import {
  MORPHO_ACTIVITY_LIQUIDATION_PAGE,
  MORPHO_ACTIVITY_MIXED_PAGE,
  MORPHO_MARKET_POSITIONS_PAGE,
  MORPHO_VAULT_POSITIONS_PAGE,
  MORPHO_VAULT_V2_POSITION,
} from "./position-fixtures.js";

const WALLET = "0x2a315c59a6a95aeeec085c73badac801c2f4209f";

/**
 * A REAL `Response`, not a hand-shaped stand-in: the Morpho client reads `ok`,
 * `status`, `headers.get("retry-after")` and `json()`, and a fake that answers
 * those four by hand would keep passing if the client started reading a fifth.
 */
function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

interface SentCall {
  query: string;
  variables: Record<string, unknown>;
}

/** Answer each outbound query with the body matching its operation name. */
function stubMorphoByOperation(bodies: Record<string, unknown>): { calls: SentCall[] } {
  const calls: SentCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const sent = JSON.parse(String(init.body)) as SentCall;
      calls.push(sent);
      const key = Object.keys(bodies).find((k) => sent.query.includes(k));
      return jsonResponse(key === undefined ? { data: null, errors: [{ message: "unstubbed" }] } : bodies[key]);
    }),
  );
  return { calls };
}

function data(result: { output: string }): Record<string, unknown> {
  return JSON.parse(result.output) as Record<string, unknown>;
}

const EMPTY_V2_SCAN = {
  data: { vaultV2transactions: { pageInfo: { countTotal: 0, count: 0, limit: 100, skip: 0 }, items: [] } },
};

/** Every operation the positions handler can reach, answered with live bodies. */
function stubFullPortfolio(): { calls: SentCall[] } {
  return stubMorphoByOperation({
    VexMorphoMarketPositions: MORPHO_MARKET_POSITIONS_PAGE,
    VexMorphoVaultPositions: MORPHO_VAULT_POSITIONS_PAGE,
    VexMorphoVaultV2UserVaults: EMPTY_V2_SCAN,
  });
}

beforeEach(() => {
  // The client singleton caches per query, so tests vary their own params.
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("morpho.positions.get param contract", () => {
  it("echoes every applied filter, including the defaults it chose", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 5 });
    const echo = data(result)["filtersApplied"] as Record<string, unknown>;
    expect(echo["walletAddress"]).toBe(WALLET);
    expect(echo["scope"]).toBe("markets");
    expect(echo["limit"]).toBe(5);
    expect(echo["offset"]).toBe(0);
    expect(echo["includeVaultV2"]).toBe(true);
  });

  it("REFUSES a second wallet address by name rather than reading only the first", async () => {
    stubFullPortfolio();
    for (const value of [[WALLET, WALLET], `${WALLET},${WALLET}`]) {
      const result = await morphoPositionsGet({ walletAddress: value, limit: 5 });
      expect(result.output).toContain("walletAddress");
      expect(result.output).toMatch(/ONE address/);
      expect(result.output).toMatch(/once per wallet/);
    }
  });

  it("requires a wallet address at all", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ limit: 5 });
    expect(result.output).toMatch(/`walletAddress` is required/);
  });

  it("refuses an off-enum scope BY NAME and names the accepted set", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "everything" });
    expect(result.output).toContain("`scope` must be one of: markets, vaults, all");
  });

  it("refuses an over-limit page rather than clamping it", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, limit: 500 });
    expect(result.output).toMatch(/`limit` must be at most 50/);
    expect(result.output).toMatch(/refuses the value rather than clamping/);
  });

  it("refuses paging past the merged window, and says why and what to do instead", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, offset: 40, limit: 30 });
    expect(result.output).toMatch(/must stay within 50 rows/);
    expect(result.output).toMatch(/maxHealthFactor/);
  });

  it("refuses maxHealthFactor against a vaults-only scope, because a deposit has none", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "vaults", maxHealthFactor: 1.2 });
    expect(result.output).toMatch(/cannot be liquidated and has no health factor/);
  });
});

describe("morpho.positions.get market half", () => {
  it("issues THREE reads and reports their totals as overlapping, never summed", async () => {
    const { calls } = stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 10 });
    const positionCalls = calls.filter((c) => c.query.includes("VexMorphoMarketPositions"));
    expect(positionCalls).toHaveLength(3);
    const predicates = positionCalls.map((c) => Object.keys(c.variables["where"] as object).sort().join(","));
    expect(predicates).toEqual([
      "collateral_gte,userAddress_in",
      "supplyShares_gte,userAddress_in",
      "borrowShares_gte,userAddress_in",
    ].sort((a, b) => predicates.indexOf(a) - predicates.indexOf(b)));

    const section = data(result)["marketPositions"] as Record<string, unknown>;
    expect(Object.keys(section["matchedByFilter"] as object).sort())
      .toEqual(["withCollateral", "withDebt", "withSupply"]);
    expect(String(section["ranking"])).toMatch(/OVERLAP and must\s+not be added together/);
  });

  it("orders the merged rows riskiest first, and dedupes rows returned by two predicates", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 10, offset: 0 });
    const section = data(result)["marketPositions"] as { rows: Record<string, unknown>[] };
    const ids = section.rows.map((r) => r["positionId"]);
    expect(new Set(ids).size).toBe(ids.length);
    const factors = section.rows
      .map((r) => (r["healthFactor"] === null ? null : Number(r["healthFactor"])))
      .filter((f): f is number => f !== null);
    expect([...factors].sort((a, b) => a - b)).toEqual(factors);
    expect(factors[0]).toBeCloseTo(0.3053, 4);
  });

  it("switches to ONE server-paged read when maxHealthFactor is set", async () => {
    const { calls } = stubFullPortfolio();
    await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", maxHealthFactor: 1.2, limit: 7 });
    const positionCalls = calls.filter((c) => c.query.includes("VexMorphoMarketPositions"));
    expect(positionCalls).toHaveLength(1);
    const where = positionCalls[0].variables["where"] as Record<string, unknown>;
    expect(where["healthFactor_lte"]).toBe(1.2);
    expect(positionCalls[0].variables["orderBy"]).toBe("HealthFactor");
    expect(positionCalls[0].variables["orderDirection"]).toBe("Asc");
  });

  it("says that a health-factor filter excludes supply-only positions by construction", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", maxHealthFactor: 1.5 });
    expect(String(data(result)["summary"])).toMatch(/absent by construction rather than because none exist/);
  });
});

describe("morpho.positions.get projection", () => {
  it("never emits a raw amount without decimals and an exact human rendering", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, limit: 10 });
    const payload = data(result);
    const section = payload["marketPositions"] as { rows: Record<string, unknown>[] };
    let checked = 0;
    for (const row of section.rows) {
      for (const key of ["collateral", "supply", "borrow", "margin", "borrowPnl"]) {
        const amount = row[key] as { raw: string; decimals: number; human: string } | null;
        if (amount === null) continue;
        expect(typeof amount.decimals, `${key}.decimals`).toBe("number");
        expect(amount.human).toBe(formatRawAmount(amount.raw, amount.decimals));
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("emits the health factor as a decimal STRING with its band, never a rounded float", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 10 });
    const section = data(result)["marketPositions"] as { rows: Record<string, unknown>[] };
    const worst = section.rows[0];
    expect(worst["healthFactor"]).toBe("0.3053054108729547");
    expect(worst["healthFactorBand"]).toBe("liquidatable_now");
  });

  it("bands an absent health factor as no_debt, never as a safe number", () => {
    expect(healthFactorBand(null)).toBe("no_debt");
    expect(healthFactorBand(1)).toBe("liquidatable_now");
    expect(healthFactorBand(0.99)).toBe("liquidatable_now");
    expect(healthFactorBand(1.01)).toBe("critical");
    expect(healthFactorBand(1.2)).toBe("tight");
    expect(healthFactorBand(1.5)).toBe("moderate");
    expect(healthFactorBand(3)).toBe("comfortable");
  });

  it("counts liquidatable positions in riskFlags and leads the summary with them", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 10 });
    const payload = data(result);
    const flags = payload["riskFlags"] as Record<string, unknown>;
    expect(Number(flags["liquidatableNow"])).toBeGreaterThan(0);
    expect(flags["lowestHealthFactor"]).toBe("0.3053054108729547");
    expect(String(payload["summary"])).toMatch(/LIQUIDATABLE NOW/);
    expect(String(payload["summary"])).toMatch(/no close\s+factor/);
  });

  it("labels USD totals as oracle estimates and counts the rows it could not price", async () => {
    stubFullPortfolio();
    const result = await morphoPositionsGet({ walletAddress: WALLET, limit: 10 });
    const payload = data(result);
    const totals = payload["portfolioTotalsUsd"] as Record<string, unknown>;
    expect(totals).toHaveProperty("rowsWithoutUsd");
    expect(String((payload["notes"] as Record<string, unknown>)["usd"])).toMatch(/oracle mark/);
  });
});

describe("morpho.positions.get vault half", () => {
  it("reports V2 sweep coverage rather than implying the list is everything", async () => {
    stubMorphoByOperation({
      VexMorphoMarketPositions: MORPHO_MARKET_POSITIONS_PAGE,
      VexMorphoVaultPositions: MORPHO_VAULT_POSITIONS_PAGE,
      VexMorphoVaultV2UserVaults: {
        data: {
          vaultV2transactions: {
            pageInfo: { countTotal: 4_000, count: 1, limit: 100, skip: 0 },
            items: [{ vault: { address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", chain: { id: 8453 } } }],
          },
        },
      },
      VexMorphoVaultV2Position: MORPHO_VAULT_V2_POSITION,
    });
    // A distinct wallet: the client's 5-second TTL cache is keyed on the query
    // variables, and an earlier test in this file already primed the V2 sweep
    // for WALLET with an empty scan.
    const result = await morphoPositionsGet({
      walletAddress: "0x9b746dbc5269e1df6e4193bcb441c0fbbf1cecee",
      scope: "vaults",
      limit: 9,
    });
    const payload = data(result);
    const section = payload["vaultPositions"] as Record<string, unknown>;
    const coverage = section["vaultV2Coverage"] as Record<string, unknown>;
    expect(coverage["complete"]).toBe(false);
    expect(coverage["totalTransactions"]).toBe(4_000);
    expect(coverage["vaultsRead"]).toBe(1);
    expect(String((payload["notes"] as Record<string, unknown>)["vaultV2"])).toMatch(/coverage is PARTIAL/);
    const versions = (section["rows"] as Record<string, unknown>[]).map((r) =>
      (r["vault"] as Record<string, unknown>)["version"]);
    expect(versions).toContain("v2");
  });

  it("makes NO V2 claim at all when the sweep is switched off", async () => {
    const { calls } = stubFullPortfolio();
    const result = await morphoPositionsGet({
      walletAddress: WALLET,
      scope: "vaults",
      includeVaultV2: false,
      limit: 8,
    });
    expect(calls.some((c) => c.query.includes("VexMorphoVaultV2"))).toBe(false);
    const section = data(result)["vaultPositions"] as Record<string, unknown>;
    expect(section["vaultV2Coverage"]).toBeNull();
  });

  it("scopes to markets or to vaults without reading the other half", async () => {
    const marketsOnly = stubFullPortfolio();
    await morphoPositionsGet({ walletAddress: WALLET, scope: "markets", limit: 6 });
    expect(marketsOnly.calls.some((c) => c.query.includes("VexMorphoVaultPositions"))).toBe(false);
    vi.unstubAllGlobals();

    const vaultsOnly = stubFullPortfolio();
    await morphoPositionsGet({ walletAddress: WALLET, scope: "vaults", limit: 6 });
    expect(vaultsOnly.calls.some((c) => c.query.includes("VexMorphoMarketPositions"))).toBe(false);
  });
});

describe("morpho.markets.activity", () => {
  it("echoes every applied filter and maps the type vocabulary to Morpho's enum", async () => {
    const { calls } = stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_LIQUIDATION_PAGE });
    const result = await morphoMarketsActivity({
      chainIds: "base",
      types: "liquidation,supplyCollateral",
      since: 1_700_000_000,
      limit: 3,
    });
    const echo = data(result)["filtersApplied"] as Record<string, unknown>;
    expect(echo["types"]).toEqual(["liquidation", "supplyCollateral"]);
    expect(echo["since"]).toBe(1_700_000_000);
    expect(echo["sort"]).toBe("timestamp");
    const where = calls[0].variables["where"] as Record<string, unknown>;
    expect(where["type_in"]).toEqual(["Liquidation", "SupplyCollateral"]);
    expect(where["timestamp_gte"]).toBe(1_700_000_000);
  });

  it("refuses an unknown event type BY NAME and lists the accepted set", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_MIXED_PAGE });
    const result = await morphoMarketsActivity({ types: "liquidated", limit: 3 });
    expect(result.output).toContain('`types` contains "liquidated"');
    expect(result.output).toContain("supplyCollateral");
  });

  it("refuses a milliseconds timestamp by name, naming the mistake", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_MIXED_PAGE });
    const result = await morphoMarketsActivity({ since: 1_786_707_181_000, limit: 3 });
    expect(result.output).toMatch(/not a unix SECONDS timestamp/);
    expect(result.output).toMatch(/Divide by 1000/);
  });

  it("refuses an address where a market id belongs, saying what it actually is", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_MIXED_PAGE });
    const result = await morphoMarketsActivity({ marketIds: WALLET, limit: 3 });
    expect(result.output).toMatch(/not a 0x-prefixed 64-hex market id/);
    expect(result.output).toMatch(/20-byte contract ADDRESS/);
  });

  it("refuses a window whose start is after its end", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_MIXED_PAGE });
    const result = await morphoMarketsActivity({ since: 1_700_000_100, until: 1_700_000_000, limit: 3 });
    expect(result.output).toMatch(/nothing can match/);
  });

  it("gives a liquidation row both legs, in their own assets, with exact human values", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_LIQUIDATION_PAGE });
    const result = await morphoMarketsActivity({ types: "liquidation", limit: 3, offset: 0 });
    const payload = data(result);
    const row = (payload["transactions"] as Record<string, unknown>[])[0];
    expect(row["type"]).toBe("liquidation");
    expect(row["liquidatorAddress"]).toBe("0x6cf59693571329db4a613f9a398205e6de04d05f");
    const repaid = row["amounts"] as Record<string, { raw: string; decimals: number; human: string; asset: string }>;
    expect(repaid["repaidAssets"].asset).toBe("loan");
    expect(repaid["repaidAssets"].decimals).toBe(6);
    expect(repaid["repaidAssets"].human).toBe(formatRawAmount("12004", 6));
    expect(repaid["seizedAssets"].asset).toBe("collateral");
    expect(repaid["seizedAssets"].decimals).toBe(18);
    expect(repaid["badDebtAssets"]).toBeDefined();
    // No USD anywhere on a transaction row, ever.
    expect(JSON.stringify(row["amounts"])).not.toContain("usd");
  });

  it("labels the page breakdown as per-page, not as a market's liquidation rate", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_LIQUIDATION_PAGE });
    const result = await morphoMarketsActivity({ types: "liquidation", limit: 3, offset: 1 });
    const breakdown = data(result)["pageBreakdown"] as Record<string, unknown>;
    expect(breakdown["liquidations"]).toBe(3);
    expect(breakdown["liquidationsWithBadDebt"]).toBe(0);
    expect(String(breakdown["scope"])).toMatch(/not a market's liquidation rate/);
  });

  it("derives hasMore from offset plus returned, not from the page looking full", async () => {
    stubMorphoByOperation({ VexMorphoMarketTransactions: MORPHO_ACTIVITY_LIQUIDATION_PAGE });
    const result = await morphoMarketsActivity({ types: "liquidation", limit: 3, offset: 2 });
    const payload = data(result);
    expect(payload["matched"]).toBeGreaterThan(3);
    expect(payload["hasMore"]).toBe(true);
    expect(payload["nextOffset"]).toBe(2 + (payload["returned"] as number));
  });
});

describe("morpho.positions.get vault paging honesty", () => {
  it("says which vault rows came from the V1 page and which from the V2 sweep", async () => {
    // The V1 page is bounded by `limit`; the V2 sweep is bounded by its own
    // coverage. So `returned` can exceed `limit`, and reporting one number
    // would make an over-long list look like a paging bug instead of a merge.
    stubMorphoByOperation({
      VexMorphoMarketPositions: MORPHO_MARKET_POSITIONS_PAGE,
      VexMorphoVaultPositions: MORPHO_VAULT_POSITIONS_PAGE,
      VexMorphoVaultV2UserVaults: {
        data: {
          vaultV2transactions: {
            pageInfo: { countTotal: 1, count: 1, limit: 100, skip: 0 },
            items: [{ vault: { address: "0xbeef0e0834849aCC03f0089F01f4F1Eeb06873C9", chain: { id: 8453 } } }],
          },
        },
      },
      VexMorphoVaultV2Position: MORPHO_VAULT_V2_POSITION,
    });
    const result = await morphoPositionsGet({
      walletAddress: "0x1111111111111111111111111111111111111111",
      scope: "vaults",
      limit: 11,
    });
    const payload = data(result);
    const section = payload["vaultPositions"] as Record<string, unknown>;
    expect(section["v1Returned"]).toBe(3);
    expect(section["v2Returned"]).toBe(1);
    expect(section["returned"]).toBe(4);
    expect((section["vaultV2Coverage"] as Record<string, unknown>)["complete"]).toBe(true);
    expect(String((payload["notes"] as Record<string, unknown>)["vaultPaging"])).toMatch(/can exceed `limit`/);
  });
});
