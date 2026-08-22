/**
 * Morpho VAULT handler behaviour: the agent-facing contract.
 *
 * Five properties are asserted, each because breaking it would mislead the agent
 * in a way it could not detect:
 *   - every filter is ECHOED in `filtersApplied`;
 *   - a value one vault generation cannot serve is REJECTED BY NAME, never
 *     half-applied to the generation that can;
 *   - the `version: both` merge is HONEST - both generations are queried, the
 *     union is re-sorted, and the reply says which of those happened;
 *   - a raw amount never appears without its decimals and an exact human
 *     rendering;
 *   - the vault APY basis is labelled and the `gated` flag survives projection.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { morphoVaultsDiscover } from "../../../../../vex-agent/tools/protocols/morpho/handlers/vaults-discover.js";
import { morphoVaultGet } from "../../../../../vex-agent/tools/protocols/morpho/handlers/vault-get.js";
import { formatRawAmount } from "../../../../../vex-agent/tools/protocols/morpho/projectors.js";
import {
  MORPHO_VAULTS_V1_PAGE,
  MORPHO_VAULTS_V2_PAGE,
  MORPHO_VAULT_V1_DETAIL,
  MORPHO_VAULT_V2_DETAIL_GATED,
  MORPHO_VAULT_NOT_FOUND,
} from "./vault-fixtures.js";

/**
 * A REAL `Response`: the Morpho client reads `ok`, `status`,
 * `headers.get("retry-after")` and `json()`, and a hand-shaped double that
 * answers exactly those keeps passing if the client starts reading a fifth.
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

/**
 * Answer each outbound query with the body that matches its operation name, so
 * a `version: both` call gets a real V1 page AND a real V2 page rather than the
 * same body twice.
 */
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

beforeEach(() => {
  // The client singleton caches responses per query for 15 seconds, so each test
  // varies its own params to avoid a cross-test cache hit.
  vi.resetModules();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("morpho.vaults.discover param contract", () => {
  it("echoes every applied filter, including the defaults it chose", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    const result = await morphoVaultsDiscover({
      version: "v1",
      chainIds: "base",
      minTvlUsd: 1000,
      maxCuratorCutPercent: 20,
      minNetApyPercent: 2,
      limit: 3,
    });
    expect(result.success).toBe(true);
    const applied = data(result)["filtersApplied"] as Record<string, unknown>;
    expect(applied["version"]).toBe("v1");
    expect(applied["minTvlUsd"]).toBe(1000);
    expect(applied["maxCuratorCutPercent"]).toBe(20);
    expect(applied["minNetApyPercent"]).toBe(2);
    // Defaults are echoed too: a default the agent did not choose is still a
    // filter that was applied.
    expect(applied["listedOnly"]).toBe(true);
    expect(applied["sort"]).toBe("tvlUsd");
    expect(applied["order"]).toBe("desc");
  });

  it("converts percent to the scale EACH generation's filter actually takes", async () => {
    const v1 = stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    await morphoVaultsDiscover({ version: "v1", maxCuratorCutPercent: 25, minNetApyPercent: 4, limit: 4 });
    const v1Where = v1.calls[0].variables["where"] as Record<string, unknown>;
    // V1 takes a FRACTION.
    expect(v1Where["fee_lte"]).toBe(0.25);
    expect(v1Where["netApy_gte"]).toBe(0.04);

    vi.unstubAllGlobals();
    const v2 = stubMorphoByOperation({ VexMorphoVaultsV2: MORPHO_VAULTS_V2_PAGE });
    await morphoVaultsDiscover({ version: "v2", maxCuratorCutPercent: 25, minNetApyPercent: 4, limit: 5 });
    const v2Where = v2.calls[0].variables["where"] as Record<string, unknown>;
    // V2 takes a WAD STRING for the same agent-facing percent.
    expect(v2Where["performanceFee_lte"]).toBe("250000000000000000");
    expect(v2Where["netApy_gte"]).toBe(0.04);
  });

  it("rejects a V1-only predicate BY NAME when v2 is in scope, instead of half-applying it", async () => {
    const { calls } = stubMorphoByOperation({});
    for (const params of [{ search: "steakhouse" }, { assetSymbol: "USDC" }]) {
      const result = await morphoVaultsDiscover(params);
      expect(result.success).toBe(false);
      expect(result.output).toMatch(/V1-only predicate/);
      expect(result.output).toMatch(/version/);
    }
    // Nothing was sent: the refusal happens before any request leaves.
    expect(calls).toHaveLength(0);
  });

  it("accepts the same V1-only predicate once version is narrowed to v1", async () => {
    const { calls } = stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    const result = await morphoVaultsDiscover({ version: "v1", search: "steakhouse", limit: 6 });
    expect(result.success).toBe(true);
    expect((calls[0].variables["where"] as Record<string, unknown>)["search"]).toBe("steakhouse");
  });

  it("rejects a sort a generation cannot serve BY NAME rather than reordering by something else", async () => {
    const { calls } = stubMorphoByOperation({});
    const result = await morphoVaultsDiscover({ sort: "name" });
    expect(result.success).toBe(false);
    expect(result.output).toMatch(/not a ranking/);
    expect(result.output).toMatch(/v2/);
    expect(calls).toHaveLength(0);

    const offEnum = await morphoVaultsDiscover({ sort: "sharpeRatio" });
    expect(offEnum.success).toBe(false);
    expect(offEnum.output).toContain("`sort` must be one of");
  });

  it("rejects an over-limit page and an unmergeable window by name, never clamping", async () => {
    const tooBig = await morphoVaultsDiscover({ limit: 500 });
    expect(tooBig.success).toBe(false);
    expect(tooBig.output).toMatch(/at most 50/);

    const unmergeable = await morphoVaultsDiscover({ offset: 40, limit: 20 });
    expect(unmergeable.success).toBe(false);
    expect(unmergeable.output).toMatch(/merged page it cannot prove is correctly ranked/);
  });

  it("rejects an off-enum version by name", async () => {
    const result = await morphoVaultsDiscover({ version: "v3" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("`version` must be one of");
  });
});

describe("morpho.vaults.discover version merge", () => {
  it("queries BOTH generations, re-sorts the union, and says so", async () => {
    const { calls } = stubMorphoByOperation({
      VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE,
      VexMorphoVaultsV2: MORPHO_VAULTS_V2_PAGE,
    });
    const result = await morphoVaultsDiscover({ sort: "tvlUsd", order: "desc", limit: 10 });
    expect(result.success).toBe(true);
    const body = data(result);

    expect(calls).toHaveLength(2);
    expect(calls.some((c) => c.query.includes("VexMorphoVaultsV1"))).toBe(true);
    expect(calls.some((c) => c.query.includes("VexMorphoVaultsV2"))).toBe(true);

    const vaults = body["vaults"] as Array<Record<string, unknown>>;
    expect(new Set(vaults.map((v) => v["version"])).size).toBe(2);

    // The union really is re-sorted, not concatenated per source.
    const tvls = vaults.map((v) => ((v["tvl"] as Record<string, unknown>)["usd"] as number));
    expect([...tvls]).toEqual([...tvls].sort((a, b) => b - a));

    // `matched` is the SUM of both totals, which is exact.
    expect(body["matched"]).toBe(
      MORPHO_VAULTS_V1_PAGE.data.vaults.pageInfo.countTotal + MORPHO_VAULTS_V2_PAGE.data.vaultV2s.pageInfo.countTotal,
    );
    // The reply states the semantics rather than leaving them implicit.
    expect(String(body["ranking"])).toMatch(/merged and re-sorted/);
  });

  it("asks each source for the whole window when merging, and only the page when not", async () => {
    const merged = stubMorphoByOperation({
      VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE,
      VexMorphoVaultsV2: MORPHO_VAULTS_V2_PAGE,
    });
    await morphoVaultsDiscover({ offset: 5, limit: 10, minTvlUsd: 7 });
    for (const call of merged.calls) {
      expect(call.variables["first"]).toBe(15);
      expect(call.variables["skip"]).toBe(0);
    }

    vi.unstubAllGlobals();
    const single = stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    await morphoVaultsDiscover({ version: "v1", offset: 5, limit: 10, minTvlUsd: 8 });
    expect(single.calls[0].variables["first"]).toBe(10);
    expect(single.calls[0].variables["skip"]).toBe(5);
  });

  it("reports a single-generation call as server-side ranked, not merged", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV2: MORPHO_VAULTS_V2_PAGE });
    const result = await morphoVaultsDiscover({ version: "v2", limit: 7 });
    expect(String(data(result)["ranking"])).toMatch(/ranked and paged them server-side/);
  });
});

describe("morpho.vaults.discover output contract", () => {
  it("gives every raw amount its decimals and an EXACT human rendering", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    const result = await morphoVaultsDiscover({ version: "v1", limit: 9 });
    for (const vault of data(result)["vaults"] as Array<Record<string, unknown>>) {
      const tvl = vault["tvl"] as Record<string, unknown>;
      expect(typeof tvl["raw"]).toBe("string");
      expect(typeof tvl["decimals"]).toBe("number");
      expect(tvl["human"]).toBe(formatRawAmount(String(tvl["raw"]), Number(tvl["decimals"])));
    }
  });

  it("labels the vault APY basis and never emits a bare APY number", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    const result = await morphoVaultsDiscover({ version: "v1", limit: 11 });
    const body = data(result);
    expect(String((body["notes"] as Record<string, unknown>)["apy"])).toMatch(/NET OF THE VAULT'S FEE/);

    for (const [index, vault] of (body["vaults"] as Array<Record<string, unknown>>).entries()) {
      const apy = vault["apy"] as Record<string, unknown>;
      const state = MORPHO_VAULTS_V1_PAGE.data.vaults.items[index].state;
      expect(String(apy["basis"])).toMatch(/unlike a market APY which is gross/);
      // Fraction in, percent out, exactly once, and under the right basis key.
      expect(apy["apyPercent"]).toBeCloseTo(state.apy * 100, 10);
      expect(apy["netApyPercent"]).toBeCloseTo(state.netApy * 100, 10);
      expect(apy).not.toHaveProperty("apy");
    }
  });

  it("surfaces the gated flag in the row, the summary and the count", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV2: MORPHO_VAULTS_V2_PAGE });
    const result = await morphoVaultsDiscover({ version: "v2", limit: 12 });
    const body = data(result);
    const vaults = body["vaults"] as Array<Record<string, unknown>>;
    const gated = vaults.filter((v) => ((v["gating"] as Record<string, unknown>)["gated"] as boolean));
    expect(gated.length).toBeGreaterThan(0);
    expect(String(body["summary"])).toMatch(/GATED/);
    expect(String((body["notes"] as Record<string, unknown>)["gating"])).toMatch(/REFUSE it/);
  });

  it("keeps the gated flags even when the gating field group is dropped", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV2: MORPHO_VAULTS_V2_PAGE });
    const result = await morphoVaultsDiscover({ version: "v2", fields: "identity,size", limit: 13 });
    for (const vault of data(result)["vaults"] as Array<Record<string, unknown>>) {
      expect(vault).toHaveProperty("gated");
      expect(vault).toHaveProperty("withdrawalGated");
      expect(vault).not.toHaveProperty("apy");
    }
  });

  it("says plainly when unlisted vaults were included", async () => {
    stubMorphoByOperation({ VexMorphoVaultsV1: MORPHO_VAULTS_V1_PAGE });
    const result = await morphoVaultsDiscover({ version: "v1", listedOnly: false, limit: 14 });
    const body = data(result);
    expect(String(body["summary"])).toMatch(/INCLUDING unlisted/);
    expect(String((body["notes"] as Record<string, unknown>)["listed"])).toMatch(/UNLISTED vaults are included/);
  });
});

describe("morpho.vault.get", () => {
  it("detects the generation by trying V2 first and falling back to V1", async () => {
    const { calls } = stubMorphoByOperation({
      VexMorphoVaultV2: MORPHO_VAULT_NOT_FOUND,
      VexMorphoVaultV1: MORPHO_VAULT_V1_DETAIL,
    });
    const result = await morphoVaultGet({
      vaultAddress: MORPHO_VAULT_V1_DETAIL.data.vaultByAddress.address,
      chain: "ethereum",
    });
    expect(result.success).toBe(true);
    expect(calls.map((c) => (c.query.includes("VexMorphoVaultV2") ? "v2" : "v1"))).toEqual(["v2", "v1"]);
    const vault = data(result)["vault"] as Record<string, unknown>;
    expect(vault["version"]).toBe("v1");
    // A V1 miss on the way to a V1 hit is never reported as a failure.
    expect(result.output).not.toMatch(/failed/);
  });

  it("returns the roles, the queued-change COUNT and the allocation table", async () => {
    stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_NOT_FOUND, VexMorphoVaultV1: MORPHO_VAULT_V1_DETAIL });
    const result = await morphoVaultGet({
      vaultAddress: MORPHO_VAULT_V1_DETAIL.data.vaultByAddress.address,
      chain: "ethereum",
      includeAllocations: true,
    });
    const vault = data(result)["vault"] as Record<string, unknown>;
    const config = vault["config"] as Record<string, unknown>;
    expect(config["guardianAddress"]).toBeTruthy();
    expect(config["pendingConfigCount"]).toBe(
      MORPHO_VAULT_V1_DETAIL.data.vaultByAddress.state.pendingConfigs.pageInfo.countTotal,
    );
    expect(String(config["note"])).toMatch(/drift/);

    const allocations = vault["allocations"] as Record<string, unknown>;
    const markets = allocations["markets"] as Array<Record<string, unknown>>;
    expect(markets.length).toBe(MORPHO_VAULT_V1_DETAIL.data.vaultByAddress.state.allocation.length);
    for (const market of markets) {
      expect(String(market["marketId"])).toMatch(/^0x[0-9a-f]{64}$/);
      expect(typeof market["lltvPercent"]).toBe("number");
      const supplied = market["supplied"] as Record<string, unknown> | null;
      if (supplied !== null) {
        expect(supplied["human"]).toBe(formatRawAmount(String(supplied["raw"]), Number(supplied["decimals"])));
      }
    }
    // The allocations' market APYs are GROSS and the reply says so.
    expect(String(allocations["note"])).toMatch(/GROSS of this vault's fee/);
  });

  it("warns in the SUMMARY when a V2 vault is gated", async () => {
    stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_V2_DETAIL_GATED });
    const result = await morphoVaultGet({
      vaultAddress: MORPHO_VAULT_V2_DETAIL_GATED.data.vaultV2ByAddress.address,
      chain: "base",
    });
    const body = data(result);
    expect(String(body["summary"])).toMatch(/gated/i);
    const gating = (body["vault"] as Record<string, unknown>)["gating"] as Record<string, unknown>;
    expect(gating["gated"]).toBe(true);
  });

  it("reports a genuine miss only after BOTH registries were checked", async () => {
    stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_NOT_FOUND, VexMorphoVaultV1: MORPHO_VAULT_NOT_FOUND });
    const result = await morphoVaultGet({
      vaultAddress: "0x0000000000000000000000000000000000000009",
      chain: "ethereum",
    });
    expect(result.success).toBe(false);
    // The real cause, classified, with the remediation appended - not a generic
    // label and not a schema-refusal message.
    expect(result.output).toContain("morpho__vault_get failed [MORPHO_VAULT_NOT_FOUND/not_found");
    expect(result.output).toMatch(/checked both the V2 and the V1 vault registries/);
  });

  it("rejects a market id in vaultAddress by name, and a missing chain by name", async () => {
    const wrongShape = await morphoVaultGet({
      vaultAddress: "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836",
      chain: "base",
    });
    expect(wrongShape.success).toBe(false);
    expect(wrongShape.output).toMatch(/MARKET id/);

    const noChain = await morphoVaultGet({ vaultAddress: "0x0000000000000000000000000000000000000009" });
    expect(noChain.success).toBe(false);
    expect(noChain.output).toContain("`chain` is required");
  });

  it("defaults includeAllocations to true and echoes both toggles", async () => {
    stubMorphoByOperation({ VexMorphoVaultV2: MORPHO_VAULT_V2_DETAIL_GATED });
    const result = await morphoVaultGet({
      vaultAddress: MORPHO_VAULT_V2_DETAIL_GATED.data.vaultV2ByAddress.address,
      chain: "base",
      includeHistory: true,
    });
    const body = data(result);
    const applied = body["filtersApplied"] as Record<string, unknown>;
    expect(applied["includeAllocations"]).toBe(true);
    expect(applied["includeHistory"]).toBe(true);
    expect((body["vault"] as Record<string, unknown>)["apyHistory"]).not.toBeNull();
  });
});
