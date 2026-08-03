/**
 * `pendle.yields` — the redesigned market screen, driven by the live catalogue
 * fixture.
 *
 * Three defects are pinned closed here, each of which shipped:
 *   - the 11-call per-chain fan-out is now ONE cross-chain catalogue read;
 *   - `limit` is no longer silently clamped to 50 with no echo;
 *   - a rate is no longer a bare fraction — 0.0228 reaches the agent as
 *     `impliedApyPercent: "2.28"`, with the unit in the field name.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendleReadMarketCatalog } from "@tools/pendle/read/types.js";
import type { PendleAsset } from "@tools/pendle/types.js";

const mockListMarkets = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({ listMarkets: (...a: unknown[]) => mockListMarkets(...a) }),
}));

const mockBuildAssetMap = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  buildAssetMap: (...a: unknown[]) => mockBuildAssetMap(...a),
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { pendleYields } = await import("@vex-agent/tools/protocols/pendle/handlers/yields.js");
const { PENDLE_MARKETS_ACTIVE_PAGE, PENDLE_MARKETS_MATURED_PAGE } = await import("./read-surface-fixtures.js");
const { validatePendleMarketPage } = await import("@tools/pendle/read/validation/market-catalog.js");

/** Validated live rows: two active chain-1 markets plus the matured srUSDe one. */
const ACTIVE_ROWS = validatePendleMarketPage(PENDLE_MARKETS_ACTIVE_PAGE).results;
const MATURED_ROWS = validatePendleMarketPage(PENDLE_MARKETS_MATURED_PAGE).results;

function catalog(markets = ACTIVE_ROWS, overrides: Partial<PendleReadMarketCatalog> = {}): PendleReadMarketCatalog {
  return { markets, total: markets.length, complete: true, pagesFetched: 1, ...overrides };
}

function asset(address: string, symbol: string, decimals: number): [string, PendleAsset] {
  return [
    address,
    {
      address,
      chainId: 1,
      symbol,
      decimals,
      expiry: null,
      baseType: "PT",
      priceUsd: 1,
      priceAcc: 1,
      priceUpdatedAt: null,
    },
  ];
}

/** Decimals for the legs of the two live active markets. */
function assetMap(): Map<string, PendleAsset> {
  return new Map([
    asset("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c", "PT-wstETH", 18),
    asset("0x9bf45ab47747f4b4dd09b3c2c73953484b4eb375", "PT-srUSDe", 6),
  ]);
}

interface YieldsOutput {
  matched: number;
  returned: number;
  offset: number;
  limit: number;
  hasMore: boolean;
  nextOffset: number | null;
  partial: boolean;
  catalogComplete: boolean;
  failedChains: Array<{ chain: string; reason: string }>;
  unsupportedChains: number[];
  filtersApplied: Record<string, unknown>;
  chainCounts: Array<{ chain: string; markets: number }>;
  markets: Array<Record<string, unknown>>;
  summary: string;
  asOf: string;
  nextStep: string;
}

async function run(params: Record<string, unknown> = {}): Promise<{ success: boolean; output: string; data: YieldsOutput }> {
  const result = await pendleYields(params);
  return { ...result, data: result.data as unknown as YieldsOutput };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListMarkets.mockResolvedValue(catalog());
  mockBuildAssetMap.mockResolvedValue(assetMap());
});

describe("pendle.yields — one cross-chain read", () => {
  it("makes exactly ONE catalogue call, with NO chainId — never an 11-chain fan-out", async () => {
    await run();

    expect(mockListMarkets).toHaveBeenCalledTimes(1);
    expect(mockListMarkets.mock.calls[0]![0]).toEqual({ isActive: true });
  });

  it("keeps chainId out of the request even when `chainIds` scopes the view", async () => {
    // The endpoint takes a SINGLE chain id (a csv is a documented 400), so a
    // multi-chain subset must be one cross-chain read filtered locally.
    await run({ chainIds: "ethereum,base" });

    expect(mockListMarkets).toHaveBeenCalledTimes(1);
    expect(mockListMarkets.mock.calls[0]![0]).not.toHaveProperty("chainId");
  });

  it("drops `isActive` entirely when includeMatured is set", async () => {
    await run({ includeMatured: true });
    expect(mockListMarkets.mock.calls[0]![0]).toEqual({});
  });

  it("fetches the asset catalogue only for chains actually present", async () => {
    await run();
    expect(mockBuildAssetMap).toHaveBeenCalledTimes(1);
    expect(mockBuildAssetMap).toHaveBeenCalledWith(1);
  });
});

describe("pendle.yields — output contract", () => {
  it("carries rates as PERCENT strings with the unit in the field name", async () => {
    const { data } = await run();
    const wsteth = data!.markets.find((m) => m.name === "wstETH");

    expect(wsteth!.impliedApyPercent).toBe("2.28");
    expect(wsteth).not.toHaveProperty("impliedApy");
    expect(wsteth!.swapFeeRateBps).toEqual(expect.any(String));
  });

  it("carries every leg with the DECIMALS an amount against it would need", async () => {
    const { data } = await run();
    const wsteth = data!.markets.find((m) => m.name === "wstETH") as Record<string, Record<string, unknown>>;

    expect(wsteth.pt).toEqual({
      address: "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c",
      symbol: "PT-wstETH",
      decimals: 18,
    });
    // A leg the catalogue does not price still reports its address, with
    // `decimals: null` rather than an assumed 18.
    expect(wsteth.yt).toMatchObject({ decimals: null });
  });

  it("carries daysToExpiry and matured beside the raw expiry", async () => {
    const { data } = await run();
    const row = data!.markets[0]!;

    expect(row.expiry).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(typeof row.daysToExpiry).toBe("number");
    expect(row.matured).toBe(false);
  });

  it("echoes the filters, the paging arithmetic and an explicit nextStep", async () => {
    const { data } = await run({ minLiquidityUsd: 1, sort: "impliedApy", order: "asc", limit: 1 });

    expect(data!.filtersApplied).toMatchObject({
      minLiquidityUsd: 1,
      sort: "impliedApy",
      order: "asc",
      includeMatured: false,
    });
    expect(data!.returned).toBe(1);
    expect(data!.hasMore).toBe(true);
    expect(data!.nextOffset).toBe(1);
    expect(data!.nextStep).toContain("pendle.pt.quote");
    expect(data!.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports counts per chain and a human summary", async () => {
    const { data } = await run();
    expect(data!.chainCounts).toEqual([{ chain: "ethereum", markets: 2 }]);
    expect(data!.summary).toContain("active only");
  });
});

describe("pendle.yields — no silent truncation", () => {
  it("honours a limit far above the old hidden ceiling of 50", async () => {
    const { data } = await run({ limit: 500 });
    expect(data!.limit).toBe(500);
    expect(data!.returned).toBe(2);
    expect(data!.hasMore).toBe(false);
    expect(data!.nextOffset).toBeNull();
  });

  it("pages with offset and reports what is left", async () => {
    const first = await run({ limit: 1, offset: 0 });
    expect(first.data!.hasMore).toBe(true);

    const second = await run({ limit: 1, offset: first.data!.nextOffset ?? 0 });
    expect(second.data!.returned).toBe(1);
    expect(second.data!.hasMore).toBe(false);
    expect(second.data!.markets[0]!.market).not.toBe(first.data!.markets[0]!.market);
  });

  it("marks the view PARTIAL when the catalogue walk did not finish", async () => {
    mockListMarkets.mockResolvedValue(catalog(ACTIVE_ROWS, { complete: false, total: 900 }));

    const { data } = await run();
    expect(data!.partial).toBe(true);
    expect(data!.catalogComplete).toBe(false);
    expect(data!.summary).toContain("PARTIAL");
  });

  it("NAMES a chain whose asset catalogue could not be read", async () => {
    mockBuildAssetMap.mockRejectedValue(new Error("catalogue unreadable"));

    const { data } = await run();
    expect(data!.partial).toBe(true);
    // FLIPPED (owner decree 2026-08-02): the reason is the REAL cause, scrubbed
    // — "unexpected error" told the agent nothing about WHY the chain dropped out.
    expect(data!.failedChains).toEqual([{ chain: "ethereum", reason: "catalogue unreadable" }]);
  });
});

describe("pendle.yields — filters", () => {
  it("excludes matured markets by default and includes them on request", async () => {
    mockListMarkets.mockResolvedValue(catalog([...ACTIVE_ROWS, ...MATURED_ROWS]));

    const excluded = await run();
    expect(excluded.data!.markets.some((m) => m.name === "srUSDe")).toBe(false);

    const included = await run({ includeMatured: true });
    const srUsde = included.data!.markets.find((m) => m.name === "srUSDe");
    expect(srUsde!.matured).toBe(true);
    expect(srUsde!.daysToExpiry).toBeLessThan(0);
  });

  it("filters by liquidity, APY, expiry window and category", async () => {
    const all = await run();
    const top = all.data!.markets[0]!;
    const topLiquidity = Number(top.liquidityUsd);

    const above = await run({ minLiquidityUsd: topLiquidity });
    expect(above.data!.matched).toBe(1);

    const highApy = await run({ minImpliedApyPercent: 100 });
    expect(highApy.data!.matched).toBe(0);

    const soon = await run({ maxDaysToExpiry: 1 });
    expect(soon.data!.matched).toBe(0);

    const stables = await run({ categories: "stables" });
    expect(stables.data!.matched).toBeLessThanOrEqual(all.data!.matched);
  });

  it("scopes by chain and returns nothing for a chain with no rows", async () => {
    const { data } = await run({ chainIds: "base" });
    expect(data!.matched).toBe(0);
    expect(data.filtersApplied).toMatchObject({ chainIds: ["base"] });
  });

  it("keeps only the requested field groups", async () => {
    const { data } = await run({ fields: "identity,apy" });
    const row = data!.markets[0]!;

    expect(Object.keys(row).sort()).toEqual([
      "aggregatedApyPercent",
      "chain",
      "impliedApyPercent",
      "isNew",
      "isPrime",
      "market",
      "maxBoostedApyPercent",
      "name",
      "pendleApyPercent",
      "protocol",
      "underlyingApyPercent",
      "ytFloatingApyPercent",
    ]);
  });
});

describe("pendle.yields — refusals", () => {
  it("REFUSES an unknown sort by name instead of quietly ranking by liquidity", async () => {
    const result = await run({ sort: "yield" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("sort");
    expect(result.output).toContain("impliedApy");
    expect(mockListMarkets).not.toHaveBeenCalled();
  });

  it("REFUSES an unsupported chain rather than returning a narrower view", async () => {
    const result = await run({ chainIds: "solana" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("chainIds");
  });

  it("reports a catalogue outage as a failure, never as zero markets", async () => {
    mockListMarkets.mockRejectedValue(new Error("provider down"));

    const result = await run();
    expect(result.success).toBe(false);
    expect(result.output).toContain("Pendle markets unavailable");
  });
});
