/**
 * `morpho.vaults.discover` route comparison: curated vaults against supplying a
 * Blue market directly, in one call.
 *
 * Six properties are asserted, each because breaking it would mislead the agent
 * in a way it could not detect from the reply:
 *   - `route: "curated"` is a REGRESSION PIN. It is the default, so every caller
 *     that never learned the key must still get the old reply and the old number
 *     of provider calls;
 *   - a comparison across several assets is REJECTED BY NAME rather than ranking
 *     a USDC market against a WETH vault;
 *   - each route value queries exactly what it says it does;
 *   - every option names the tool it is acted on with, and that tool id is
 *     checked against the real catalog rather than asserted from memory;
 *   - the delta is real arithmetic against the fixture's own numbers, in
 *     percentage points, not prose;
 *   - `both` ranks the union on the one comparable rate.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { morphoVaultsDiscover } from "../../../../../vex-agent/tools/protocols/morpho/handlers/vaults-discover.js";
import { getProtocolManifest } from "../../../../../vex-agent/tools/protocols/catalog.js";
import { MORPHO_MARKETS_PAGE } from "./fixtures.js";
import { MORPHO_VAULTS_V1_PAGE } from "./vault-fixtures.js";

/** The loan asset of every market in `MORPHO_MARKETS_PAGE`: USDC on Base. */
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

interface SentCall {
  query: string;
  variables: Record<string, unknown>;
}

interface MarketsFixture {
  data: { markets: { items: Array<{ state: { supplyApy: number; netSupplyApy: number } }> } };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

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

function options(body: Record<string, unknown>): Array<Record<string, unknown>> {
  return body["options"] as Array<Record<string, unknown>>;
}

function routing(option: Record<string, unknown>): Record<string, Record<string, unknown>> {
  return option["routing"] as Record<string, Record<string, unknown>>;
}

const BOTH_PAGES = {
  VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE,
  VexMorphoMarkets: MORPHO_MARKETS_PAGE,
};

beforeEach(() => {
  // The client caches per query for 15 seconds, so each test varies its `limit`.
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("morpho.vaults.discover route param contract", () => {
  it("defaults to curated and returns the pre-route reply, querying no market", async () => {
    const { calls } = stubMorphoByOperation(BOTH_PAGES);
    const result = await morphoVaultsDiscover({ version: "v1", limit: 3 });
    expect(result.success).toBe(true);
    const body = data(result);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("VexMorphoVaultsV1");
    // The default is echoed like every other applied default, and nothing else
    // about the reply changed: no comparison block exists at all.
    expect((body["filtersApplied"] as Record<string, unknown>)["route"]).toBe("curated");
    for (const key of ["options", "route", "bestDirectNetApyPercent", "directMarketsMatched"]) {
      expect(body).not.toHaveProperty(key);
    }
    expect(body).toHaveProperty("vaults");
    expect(body["notes"]).not.toHaveProperty("comparison");
  });

  it("rejects a comparison BY NAME unless exactly one asset is named", async () => {
    const { calls } = stubMorphoByOperation(BOTH_PAGES);
    for (const params of [
      { version: "v1", route: "direct" },
      { version: "v1", route: "both", assetTokenAddress: `${USDC_BASE},${USDC_BASE.replace(/913$/, "914")}` },
    ]) {
      const result = await morphoVaultsDiscover(params);
      expect(result.success).toBe(false);
      expect(result.output).toContain("assetTokenAddress");
      expect(result.output).toMatch(/EXACTLY ONE asset/);
    }
    // A refused call spends nothing at the provider.
    expect(calls).toHaveLength(0);
  });

  it("rejects an unknown route value rather than falling back to a default", async () => {
    stubMorphoByOperation(BOTH_PAGES);
    const result = await morphoVaultsDiscover({ version: "v1", route: "cheapest", assetTokenAddress: USDC_BASE });
    expect(result.success).toBe(false);
    expect(result.output).toContain("route");
  });
});

describe("morpho.vaults.discover route: direct", () => {
  it("queries the markets that lend the SAME asset and no vault at all", async () => {
    const { calls } = stubMorphoByOperation(BOTH_PAGES);
    const result = await morphoVaultsDiscover({
      version: "v1",
      route: "direct",
      assetTokenAddress: USDC_BASE,
      chainIds: "base",
      limit: 4,
    });
    expect(result.success).toBe(true);

    expect(calls).toHaveLength(1);
    expect(calls[0].query).toContain("VexMorphoMarkets");
    const where = calls[0].variables["where"] as Record<string, unknown>;
    expect(where["loanAssetAddress_in"]).toEqual([USDC_BASE.toLowerCase()]);
    expect(where["chainId_in"]).toEqual([8453]);
    expect(where["listed"]).toBe(true);
    expect(calls[0].variables["orderBy"]).toBe("NetSupplyApy");

    const body = data(result);
    expect(body).not.toHaveProperty("vaults");
    expect(body["route"]).toBe("direct");
    expect(options(body).length).toBeGreaterThan(0);
    for (const option of options(body)) {
      expect(option["kind"]).toBe("direct");
      expect((option["diversification"] as Record<string, unknown>)["marketCount"]).toBe(1);
      // No curator stands between a direct supplier and the market rate.
      expect(option["curatorFeePercent"]).toBeNull();
      expect(option["feeDragPercentagePoints"]).toBe(0);
      expect((option["risk"] as Record<string, unknown>)["lltvPercent"]).toEqual(expect.any(Number));
      expect((option["exit"] as Record<string, unknown>)["gating"]).toBeNull();
    }
    expect(String((body["notes"] as Record<string, unknown>)["concentration"])).toMatch(/ONE market/);
  });
});

describe("morpho.vaults.discover route: both", () => {
  async function bothCall(limit: number): Promise<Record<string, unknown>> {
    stubMorphoByOperation(BOTH_PAGES);
    const result = await morphoVaultsDiscover({
      version: "v1",
      route: "both",
      assetTokenAddress: USDC_BASE,
      limit,
    });
    expect(result.success).toBe(true);
    return data(result);
  }

  it("returns the vault rows AND the direct markets in one ranked list", async () => {
    const body = await bothCall(5);
    expect(body).toHaveProperty("vaults");
    expect(body["route"]).toBe("both");
    const kinds = new Set(options(body).map((option) => option["kind"]));
    expect(kinds).toEqual(new Set(["curated", "direct"]));
  });

  it("ranks the union by net APY, nulls last, in one honest ordering", async () => {
    const body = await bothCall(6);
    const rates = options(body).map((option) => option["netApyPercent"] as number | null);
    const known = rates.filter((rate): rate is number => rate !== null);
    expect(known).toEqual([...known].sort((a, b) => b - a));
    // An absent rate is not a low rate: it sorts last rather than to either end.
    expect(rates.slice(known.length).every((rate) => rate === null)).toBe(true);
  });

  it("computes the delta against the best DIRECT option in percentage points", async () => {
    const body = await bothCall(7);
    const markets = (MORPHO_MARKETS_PAGE as MarketsFixture).data.markets.items;
    const expectedBest = Math.max(...markets.map((market) => market.state.netSupplyApy)) * 100;

    expect(body["bestDirectNetApyPercent"]).toBeCloseTo(expectedBest, 10);
    for (const option of options(body)) {
      const net = option["netApyPercent"] as number | null;
      const delta = option["deltaVsBestDirectPercentagePoints"] as number | null;
      if (net === null) {
        expect(delta).toBeNull();
        continue;
      }
      expect(delta).toBeCloseTo(net - expectedBest, 10);
    }
    // The fee is what the curated side is paying to be diversified, so at least
    // one curated option must sit BELOW the best direct rate on this fixture.
    const curated = options(body).filter((option) => option["kind"] === "curated");
    expect(curated.some((option) => (option["deltaVsBestDirectPercentagePoints"] as number) < 0)).toBe(true);
  });

  it("carries the curator fee and the gross rate beside the net one, never a bare APY", async () => {
    const body = await bothCall(8);
    for (const option of options(body).filter((o) => o["kind"] === "curated")) {
      expect(option).toHaveProperty("curatorFeePercent");
      expect(option).toHaveProperty("grossApyPercent");
      expect(String(option["netApyBasis"])).toMatch(/after the curator's fee/);
      expect(option).not.toHaveProperty("apy");
    }
    expect(String((body["notes"] as Record<string, unknown>)["comparison"])).toMatch(/ONLY field comparable/);
  });
});

describe("morpho.vaults.discover route routing pointers", () => {
  it("names the quote and execute tool for every option, with the params it already knows", async () => {
    stubMorphoByOperation(BOTH_PAGES);
    const result = await morphoVaultsDiscover({
      version: "v1",
      route: "both",
      assetTokenAddress: USDC_BASE,
      limit: 9,
    });
    const body = data(result);
    expect(options(body).length).toBeGreaterThan(0);

    for (const option of options(body)) {
      const { quote, execute } = routing(option);
      const expected =
        option["kind"] === "curated"
          ? { quote: "morpho.vault.quote", execute: "morpho.vault.deposit", key: "vaultAddress" }
          : { quote: "morpho.market.quote", execute: "morpho.market.supply", key: "marketId" };

      expect(quote["toolId"]).toBe(expected.quote);
      expect(execute["toolId"]).toBe(expected.execute);
      for (const pointer of [quote, execute]) {
        const params = pointer["params"] as Record<string, unknown>;
        expect(params[expected.key]).toEqual(expect.any(String));
        expect(params["chain"]).toBe(option["chain"]);
        expect(pointer["stillNeeded"]).toContain("depositAmountRaw");
        // The pointer carries TWO identities and they must agree with the
        // catalog: `toolId` is the durable identity, `publicName` is what the
        // model actually calls. A pointer that says it is available while
        // carrying no callable name would send the model at a name the
        // catalog rejects, which is the exact defect this pair guards.
        const manifest = getProtocolManifest(String(pointer["toolId"]));
        expect(pointer["publicName"]).toBe(manifest?.publicName ?? null);
        expect(pointer["available"]).toBe(pointer["publicName"] !== null);
        expect(pointer["available"]).toBe(manifest !== undefined);
      }
    }
  });
});
