/**
 * The server-side query surface: which `filters[...]` expressions the client
 * emits, and which sort attributes it is allowed to name.
 *
 * WHY A TABLE TEST AND NOT A HANDFUL OF SPOT CHECKS (rule 10). On this provider
 * a wrong request is INVISIBLE in the response: an unknown filter key returns
 * the full population, an unknown value inside a known key returns zero rows,
 * and both are HTTP 200. The only defence is that every expression the client
 * can emit was sent live once and is pinned here against the recorded ledger of
 * those calls (`fixtures/live-probe-ledger.json`), and that the sort vocabulary
 * is checked against the provider's own 400 bodies rather than against
 * convention.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { VirtualsClient } from "@tools/virtuals/client.js";
import {
  VIRTUALS_NON_SORTABLE_FIELDS,
  VIRTUALS_SORT_FIELDS,
  type VirtualsFilters,
} from "@tools/virtuals/types.js";
import LEDGER from "../../../../virtuals/fixtures/live-probe-ledger.json" with { type: "json" };
import REJECTIONS from "../../../../virtuals/fixtures/virtuals-sort-rejections.json" with { type: "json" };

vi.mock("@utils/logger.js", () => ({
  default: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const EMPTY = { data: [], meta: { pagination: { page: 1, pageSize: 1, pageCount: 0, total: 0 } } };

let fetchSpy: ReturnType<typeof vi.spyOn>;
let client: VirtualsClient;

beforeEach(() => {
  client = new VirtualsClient("https://api.virtuals.test");
  fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => EMPTY,
    text: async () => JSON.stringify(EMPTY),
  } as unknown as Response);
});

afterEach(() => {
  fetchSpy.mockRestore();
  vi.restoreAllMocks();
});

/** The decoded query of the single request the client made. */
async function queryFor(filters: VirtualsFilters): Promise<string> {
  // A fresh client per call: the throttle caches on the request URL, and two
  // filter shapes that produced the same URL would otherwise share a response.
  const fresh = new VirtualsClient(`https://api.virtuals.test/${Math.random()}/`);
  await fresh.listVirtuals({ chain: "BASE", filters, pageSize: 1 });
  const url = new URL(fetchSpy.mock.calls.at(-1)![0] as string);
  return decodeURIComponent(url.search);
}

/**
 * One row per screen the tool exposes: what the caller asks for, the exact
 * expression the provider must receive, and the live probe that proved the
 * provider honours it. `probe` names a row of the ledger fixture.
 */
const FILTER_TABLE: readonly {
  readonly screen: string;
  readonly filters: VirtualsFilters;
  readonly expects: readonly string[];
  readonly probe: string;
}[] = [
  { screen: "status undergrad", filters: { status: "undergrad" }, expects: ["filters[status]=1"], probe: "f_status_num1" },
  { screen: "status graduated", filters: { status: "graduated" }, expects: ["filters[status]=2"], probe: "f_status_num2" },
  { screen: "status genesis", filters: { status: "genesis" }, expects: ["filters[status]=4"], probe: "st_4" },
  { screen: "verified only", filters: { isVerified: true }, expects: ["filters[isVerified]=true"], probe: "f_verified" },
  { screen: "market-cap floor", filters: { mcapInVirtual: { min: 100000 } }, expects: ["filters[mcapInVirtual][$gte]=100000"], probe: "f_mcap_gte" },
  { screen: "market-cap ceiling", filters: { mcapInVirtual: { max: 5 } }, expects: ["filters[mcapInVirtual][$lte]=5"], probe: "f_mcap_gte" },
  { screen: "holder floor", filters: { holderCount: { min: 1000 } }, expects: ["filters[holderCount][$gte]=1000"], probe: "f_holder_gte" },
  { screen: "volume floor", filters: { volume24h: { min: 10000 } }, expects: ["filters[volume24h][$gte]=10000"], probe: "f_vol24_gte" },
  { screen: "24h change floor", filters: { priceChangePercent24h: { min: 10 } }, expects: ["filters[priceChangePercent24h][$gte]=10"], probe: "f_pcp24_gte" },
  { screen: "concentration ceiling", filters: { top10HolderPercentage: { max: 20 } }, expects: ["filters[top10HolderPercentage][$lte]=20"], probe: "f_top10_lte" },
  { screen: "created after", filters: { createdAfter: "2026-08-01" }, expects: ["filters[createdAt][$gte]=2026-08-01"], probe: "f_created_gte" },
  { screen: "launched after", filters: { launchedAfter: "2026-08-01" }, expects: ["filters[launchedAt][$gte]=2026-08-01"], probe: "f_launchedat" },
  { screen: "graduated only", filters: { hasGraduated: true }, expects: ["filters[lpCreatedAt][$notNull]=true"], probe: "f_lp_notnull" },
  { screen: "name/symbol search", filters: { query: "vex", searchScope: "text" }, expects: ["filters[$or][0][name][$containsi]=vex", "filters[$or][1][symbol][$containsi]=vex"], probe: "name_containsi_case" },
  { screen: "symbol exact", filters: { symbol: "VEX" }, expects: ["filters[symbol][$eqi]=VEX"], probe: "f_symbol_eq" },
  { screen: "address lookup", filters: { tokenAddress: "0xabc" }, expects: ["filters[$or][0][tokenAddress][$eqi]=0xabc", "filters[$or][1][preToken][$eqi]=0xabc"], probe: "addr_or_eqi" },
  { screen: "creator wallet", filters: { creatorWallet: "0xdef" }, expects: ["filters[walletAddress][$eqi]=0xdef"], probe: "wallet_eqi" },
  { screen: "factory", filters: { factory: "BONDING_V5" }, expects: ["filters[factory]=BONDING_V5"], probe: "f_factory_v5" },
  { screen: "genesis linked", filters: { hasGenesis: true }, expects: ["filters[genesis][id][$notNull]=true"], probe: "f_genesis_notnull" },
  { screen: "genesis starts after", filters: { genesisStartsAfter: "2026-01-01" }, expects: ["filters[genesis][startsAt][$gte]=2026-01-01"], probe: "genesis_startsat" },
  { screen: "margin trading", filters: { hasMarginTrading: true }, expects: ["filters[hasMarginTrading]=true"], probe: "f_margin" },
  { screen: "founder video", filters: { hasFounderVideo: true }, expects: ["filters[hasFounderVideo]=true"], probe: "f_founder" },
  { screen: "dev committed", filters: { isDevCommitted: true }, expects: ["filters[isDevCommitted]=true"], probe: "f_devcommit" },
  { screen: "staking", filters: { hasStaking: true }, expects: ["filters[$or][0][stakingAddress][$notNull]=true", "filters[$or][1][agentStakingContract][$notNull]=true"], probe: "f_staking" },
  { screen: "revenue connect", filters: { hasRevenueConnect: true }, expects: ["filters[revenueConnectWallet][$notNull]=true"], probe: "f_revenue" },
  { screen: "anti-sniper configured", filters: { hasAntiSniperTax: true }, expects: ["filters[launchInfo][antiSniperTaxType][$ne]=0", "filters[launchInfo][antiSniperTaxType][$notNull]=true"], probe: "f_li_sniper" },
  { screen: "airdrop", filters: { hasAirdrop: true }, expects: ["filters[launchInfo][airdropPercent][$gt]=0"], probe: "f_li_airdrop" },
  { screen: "launch radar", filters: { launchRadarEnabled: true }, expects: ["filters[launchInfo][launchRadarEnabled][$eq]=true"], probe: "f_li_radar" },
  { screen: "robotics", filters: { isRobotics: true }, expects: ["filters[launchInfo][isRobotics][$eq]=true"], probe: "f_li_robotics" },
  { screen: "ACF", filters: { needAcf: true }, expects: ["filters[launchInfo][needAcf][$eq]=true"], probe: "li_needacf" },
  { screen: "60-day project", filters: { isProject60days: true }, expects: ["filters[launchInfo][isProject60days][$eq]=true"], probe: "li_p60" },
  { screen: "role", filters: { role: "ON_CHAIN" }, expects: ["filters[role]=ON_CHAIN"], probe: "role_onchain" },
  { screen: "vibes pre-commit", filters: { vibesStatus: "PRECOMMIT" }, expects: ["filters[vibesInfo][status]=PRECOMMIT"], probe: "b_isPreCommit" },
  { screen: "hide launch-X", filters: { excludeLaunchX: true }, expects: ["filters[category][$notIn][0]=X_LAUNCH", "filters[category][$notIn][1]=ACP_LAUNCH"], probe: "f_cat_notin" },
  { screen: "only launch-X", filters: { includeLaunchX: true }, expects: ["filters[category][$in][0]=X_LAUNCH", "filters[category][$in][1]=ACP_LAUNCH"], probe: "cat_xlaunch" },
];

describe("every exposed screen emits the measured expression", () => {
  it.each(FILTER_TABLE)("$screen", async (row) => {
    const query = await queryFor(row.filters);
    for (const expression of row.expects) expect(query).toContain(expression);
  });

  it.each(FILTER_TABLE)("$screen was sent live at least once (probe $probe)", (row) => {
    const probe = LEDGER.probes.find((p) => p.name === row.probe);
    expect(probe, `no live probe named ${row.probe} in the ledger`).toBeDefined();
    expect(probe!.status).toBe(200);
  });

  it("sends NOTHING but the chain filter when no screen was asked for", async () => {
    const query = await queryFor({});
    const filterKeys = query.match(/filters\[[^\]]+\]/g) ?? [];
    expect(filterKeys).toEqual(["filters[chain]"]);
  });
});

describe("status is the bare numeric form, because every other form is ignored", () => {
  it("never emits an operator or a string on status", async () => {
    const query = await queryFor({ status: "graduated" });
    expect(query).toContain("filters[status]=2");
    expect(query).not.toContain("filters[status][$");
    expect(query).not.toContain("AVAILABLE");
  });

  // The ledger is the evidence, not a comment: the string and operator forms
  // came back with the SAME total as the unfiltered population.
  it("the ledger shows the string and operator forms did not filter", () => {
    const unfiltered = LEDGER.probes.find((p) => p.name === "base_base")!.total;
    for (const ignored of ["f_status_av", "f_status_ug", "f_status_eq_av", "f_status_in", "status_eq_num2", "status_in_12"]) {
      const probe = LEDGER.probes.find((p) => p.name === ignored);
      expect(probe, ignored).toBeDefined();
      expect(probe!.total, `${ignored} should have been ignored by the provider`).toBeGreaterThanOrEqual(unfiltered!);
    }
  });

  it("the ledger shows an unknown filter KEY returns the whole population", () => {
    const unfiltered = LEDGER.probes.find((p) => p.name === "base_base")!.total;
    expect(LEDGER.probes.find((p) => p.name === "f_bogus")!.total).toBe(unfiltered);
  });
});

describe("the sort vocabulary comes from the provider's own rejections", () => {
  it("declares 26 sortable attributes", () => {
    expect(VIRTUALS_SORT_FIELDS).toHaveLength(26);
    expect(new Set(VIRTUALS_SORT_FIELDS).size).toBe(26);
  });

  it("excludes every attribute the provider refused, quoting its sentence", () => {
    // The machine artifact, not a convention: the 400 body names the attribute.
    const message = REJECTIONS.sort_totalSupply.error.message;
    expect(message).toBe("Attribute totalSupply not found on model api::virtual.virtual");
    for (const field of VIRTUALS_NON_SORTABLE_FIELDS) {
      expect(message).toContain(field);
      expect(VIRTUALS_SORT_FIELDS as readonly string[]).not.toContain(field);
    }
  });

  it("pins the other three provider rejections the vocabularies are read from", () => {
    expect(REJECTIONS.sort_unknown_attribute.error.status).toBe(400);
    expect(REJECTIONS.sort_missing_direction.error.status).toBe(400);
    expect(REJECTIONS.filter_unknown_operator.error.message).toBe(
      "Undefined attribute level operator $zzz",
    );
  });

  it("always emits an explicit direction, because a missing one is a 400", async () => {
    const fresh = new VirtualsClient("https://api.virtuals.test/sort/");
    await fresh.listVirtuals({ chain: "BASE", sort: "holderCount" });
    const query = decodeURIComponent(new URL(fetchSpy.mock.calls.at(-1)![0] as string).search);
    expect(query).toContain("sort[0]=holderCount:desc");
  });

  it("emits asc when asked, because the provider honours it", async () => {
    const fresh = new VirtualsClient("https://api.virtuals.test/asc/");
    await fresh.listVirtuals({ chain: "BASE", sort: "holderCount", sortDirection: "asc" });
    const query = decodeURIComponent(new URL(fetchSpy.mock.calls.at(-1)![0] as string).search);
    expect(query).toContain("sort[0]=holderCount:asc");
  });

  it("emits exactly ONE sort key - ordered multi-sort is a declared omission", async () => {
    const fresh = new VirtualsClient("https://api.virtuals.test/one/");
    await fresh.listVirtuals({ chain: "BASE", sort: "volume24h" });
    const query = decodeURIComponent(new URL(fetchSpy.mock.calls.at(-1)![0] as string).search);
    expect(query).toContain("sort[0]=");
    expect(query).not.toContain("sort[1]=");
  });
});

describe("the payload-shaping flags are sent only when asked for", () => {
  it.each(["skipStats", "sparkline", "range24h"] as const)("%s", async (flag) => {
    const off = new VirtualsClient(`https://api.virtuals.test/${flag}-off/`);
    await off.listVirtuals({ chain: "BASE" });
    expect(decodeURIComponent(new URL(fetchSpy.mock.calls.at(-1)![0] as string).search)).not.toContain(flag);

    const on = new VirtualsClient(`https://api.virtuals.test/${flag}-on/`);
    await on.listVirtuals({ chain: "BASE", [flag]: true });
    expect(decodeURIComponent(new URL(fetchSpy.mock.calls.at(-1)![0] as string).search)).toContain(`${flag}=true`);
  });
});

describe("the genesis endpoint has its own spelling", () => {
  it("takes the STRING status form, unlike the agents endpoint's numeric one", async () => {
    const fresh = new VirtualsClient("https://api.virtuals.test/gen/");
    await fresh.listGeneses({ status: "FINALIZED", chain: "BASE", startsAfter: "2026-01-01" });
    const query = decodeURIComponent(new URL(fetchSpy.mock.calls.at(-1)![0] as string).search);
    expect(query).toContain("filters[status]=FINALIZED");
    expect(query).toContain("filters[virtual][chain]=BASE");
    expect(query).toContain("filters[startsAt][$gte]=2026-01-01");
    expect(query).toContain("sort[0]=id:desc");
  });
});
