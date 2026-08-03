/**
 * `pendle.position.value` — the redesigned portfolio read, driven by the two
 * NON-EMPTY live dashboard wallets.
 *
 * Each block pins a defect that shipped:
 *   - G-16: a YT position the agent can open through `pendle.yt.buy` was one it
 *     could never see or exit — the leg was validated and then discarded.
 *   - G-18: a MATURED PT projected as `pt: null, expiry: null,
 *     redeemable: false` — the exact position the redeem product exists for,
 *     reported as not redeemable, because the resolver behind it was active-only.
 *   - G-17: `claimTokenAmounts`, `syPositions`, `activeBalance` and `updatedAt`
 *     were fetched and dropped. One probed wallet was 364 days stale and nothing
 *     said so.
 *   - G-22: balances were raw base-unit strings with no decimals, and
 *     `Number()` was applied to u256 values.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PendleAsset } from "@tools/pendle/types.js";
import type { PendleReadMarket } from "@tools/pendle/read/types.js";

const mockGetWalletPositions = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({ getWalletPositions: (...a: unknown[]) => mockGetWalletPositions(...a) }),
}));

const mockBuildAssetMap = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-lookup.js", () => ({
  buildAssetMap: (...a: unknown[]) => mockBuildAssetMap(...a),
}));

const mockResolveMarketForRead = vi.fn();
vi.mock("@vex-agent/tools/protocols/pendle/market-read.js", () => ({
  resolveMarketForRead: (...a: unknown[]) => mockResolveMarketForRead(...a),
}));

const WALLET = "0xfa4efa4efa4efa4efa4efa4efa4efa4efa4efa4e";
vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddress: () => WALLET,
}));

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const { pendlePositionValue } = await import("@vex-agent/tools/protocols/pendle/handlers/positions.js");
const { PENDLE_DASHBOARD_ACTIVE_YT, PENDLE_DASHBOARD_MATURED } = await import("./dashboard-fixtures.js");
const { validatePendleDashboardPositions } = await import("@tools/pendle/read/validation/dashboard.js");
const { makeTestContext } = await import("../../_test-context.js");

// ── Live coordinates from wallet A (matured) ───────────────────────
const MATURED_MARKET = "0xafdc922d0059147486cc1f0f32e3a2354b0d35cc";
const MATURED_PT = "0x1111111111111111111111111111111111111111";
const MATURED_YT = "0x2222222222222222222222222222222222222222";
const PENDLE_TOKEN = "0x808507121b80c02388fad14726482e061b8da827";

function pendleAsset(address: string, symbol: string, decimals: number, over: Partial<PendleAsset> = {}): PendleAsset {
  return {
    address,
    chainId: 1,
    symbol,
    decimals,
    expiry: null,
    baseType: "PT",
    priceUsd: 2,
    priceAcc: 1,
    priceUpdatedAt: null,
    ...over,
  };
}

function assetMap(): Map<string, PendleAsset> {
  return new Map([
    [MATURED_PT, pendleAsset(MATURED_PT, "PT-eUSDe", 18)],
    [MATURED_YT, pendleAsset(MATURED_YT, "YT-eUSDe", 18)],
    [MATURED_MARKET, pendleAsset(MATURED_MARKET, "LP-eUSDe", 18, { baseType: "PENDLE_LP" })],
    [PENDLE_TOKEN, pendleAsset(PENDLE_TOKEN, "PENDLE", 18, { baseType: "GENERIC" })],
  ]);
}

function marketRow(over: Partial<PendleReadMarket> = {}): PendleReadMarket {
  return {
    chainId: 1,
    address: MATURED_MARKET,
    name: "eUSDe",
    protocol: "Ethereal",
    expiry: "2025-03-27T00:00:00.000Z",
    pt: MATURED_PT,
    yt: MATURED_YT,
    sy: null,
    underlyingAsset: null,
    accountingAsset: null,
    details: {
      liquidityUsd: null,
      totalTvlUsd: null,
      tradingVolumeUsd: null,
      impliedApy: null,
      underlyingApy: null,
      pendleApy: null,
      aggregatedApy: null,
      maxBoostedApy: null,
      ytFloatingApy: null,
      swapFeeApy: null,
      feeRate: null,
      ptRoi: null,
      ytRoi: null,
    },
    categoryIds: [],
    isNew: false,
    isPrime: false,
    ...over,
  };
}

interface PositionLeg {
  chain: string;
  kind: string;
  state: string;
  stateDetermined: boolean;
  stateNote?: string;
  market: string | null;
  token: { address: string | null; symbol: string | null; decimals: number | null } | null;
  expiry: string | null;
  daysToExpiry: number | null;
  balance: { raw: string; decimals: number | null; exact: string | null };
  activeBalance?: { raw: string; decimals: number | null; exact: string | null };
  activeBalanceNote?: string;
  valueUsd: string | null;
  valuationBasis: string;
  accrued?: { items: Array<{ token: unknown; amount: { raw: string; exact: string | null } }>; totalUsd: null; note: string };
}

interface PositionsOutput {
  wallet: string;
  count: number;
  totalValueUsd: string;
  valuedLegs: number;
  unvaluedLegs: number;
  countsByState: Record<string, number>;
  countsByKind: Record<string, number>;
  partial: boolean;
  failedChains: Array<{ chain: string; reason: string }>;
  unsupportedChains: number[];
  chainFreshness: Array<{ chain: string; dataAsOf: string | null; ageHours: number | null; stalenessWarning?: string }>;
  crossPtPositions: unknown[];
  positions: PositionLeg[];
  filtersApplied: Record<string, unknown>;
  summary: string;
  nextStep: string;
}

async function run(params: Record<string, unknown> = {}) {
  const ctx = makeTestContext();
  const result = await pendlePositionValue(params, ctx);
  return { ...result, data: result.data as unknown as PositionsOutput };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetWalletPositions.mockResolvedValue(validatePendleDashboardPositions(PENDLE_DASHBOARD_MATURED));
  mockBuildAssetMap.mockResolvedValue(assetMap());
  mockResolveMarketForRead.mockImplementation((_chainId: number, market: string) =>
    Promise.resolve(
      market === MATURED_MARKET
        ? { status: "found", market: marketRow(), matured: true, matchedBy: "market", catalogScope: "ids" }
        : { status: "not_found" },
    ),
  );
});

describe("pendle.position.value — G-18: a matured PT is reachable again", () => {
  it("gives the matured PT its REAL address, expiry and redeemable state", async () => {
    const { data } = await run();
    const pt = data.positions.find((leg) => leg.kind === "pt" && leg.market === MATURED_MARKET);

    expect(pt).toBeDefined();
    expect(pt!.token?.address).toBe(MATURED_PT);
    expect(pt!.expiry).toBe("2025-03-27T00:00:00.000Z");
    expect(pt!.state).toBe("matured_redeemable");
    expect(pt!.daysToExpiry).toBeLessThan(0);
  });

  it("values a matured PT at its ACCOUNTING price, never underlying spot", async () => {
    const { data } = await run();
    const pt = data.positions.find((leg) => leg.kind === "pt" && leg.market === MATURED_MARKET);

    // priceAcc 1 vs priceUsd 2: picking the accounting basis is the difference
    // between a redemption value and a speculative mark.
    expect(pt!.valuationBasis).toBe("accounting");
    expect(pt!.valueUsd).toBe("1.056635");
  });

  it("resolves maturity through the READ resolver, not the frozen active-only one", async () => {
    await run();
    expect(mockResolveMarketForRead).toHaveBeenCalledWith(1, MATURED_MARKET, expect.any(Number));
  });

  it("redeemableOnly narrows to exactly the matured PTs", async () => {
    const { data } = await run({ redeemableOnly: true });
    expect(data.positions.length).toBeGreaterThan(0);
    for (const leg of data.positions) expect(leg.state).toBe("matured_redeemable");
  });

  it("marks the state UNDETERMINED when the catalogue could not prove maturity", async () => {
    // An indeterminate catalogue walk means we cannot say. The state still
    // defaults to the one that cannot cause an action, but it is flagged as a
    // default rather than presented as a finding.
    mockResolveMarketForRead.mockResolvedValue({ status: "indeterminate", reason: "catalog_page_budget_exhausted" });

    const { data } = await run();
    const legs = data.positions.filter((l) => l.kind !== "sy");
    expect(legs.length).toBeGreaterThan(0);
    for (const leg of legs) {
      expect(leg.expiry).toBeNull();
      expect(leg.token?.address ?? null).not.toBe(MATURED_PT);
      expect(leg.stateDetermined).toBe(false);
      expect(leg.stateNote).toContain("UNPROVEN");
      // The default must be the inactionable one — never "redeemable".
      expect(leg.state).toBe("earning");
    }
  });

  it("marks a RESOLVED leg as determined, with no note", async () => {
    const { data } = await run();
    const pt = data.positions.find((leg) => leg.kind === "pt")!;
    expect(pt.stateDetermined).toBe(true);
    expect(pt.stateNote).toBeUndefined();
  });
});

describe("pendle.position.value — G-16 / G-17: the legs that were dropped", () => {
  beforeEach(() => {
    mockGetWalletPositions.mockResolvedValue(validatePendleDashboardPositions(PENDLE_DASHBOARD_ACTIVE_YT));
    mockResolveMarketForRead.mockResolvedValue({ status: "not_found" });
  });

  it("projects YT legs, which were never shown at all", async () => {
    const { data } = await run();
    const yt = data.positions.filter((leg) => leg.kind === "yt");

    expect(yt.length).toBeGreaterThan(0);
    for (const leg of yt) expect(leg.balance.raw).toMatch(/^[1-9]\d*$/);
  });

  it("projects SY holdings", async () => {
    const { data } = await run();
    expect(data.positions.some((leg) => leg.kind === "sy")).toBe(true);
    expect(data.countsByKind.sy).toBeGreaterThan(0);
  });

  it("projects the LP staked split with a note that it is not a second holding", async () => {
    const { data } = await run();
    const split = data.positions.find((leg) => leg.activeBalanceNote !== undefined);

    expect(split).toBeDefined();
    expect(BigInt(split!.activeBalance!.raw)).toBeLessThan(BigInt(split!.balance.raw));
    expect(split!.activeBalanceNote).toContain("STAKED share");
  });

  it("projects accrued amounts with their token, and never invents a USD total", async () => {
    const { data } = await run();
    const withAccrued = data.positions.find((leg) => leg.accrued !== undefined);

    expect(withAccrued).toBeDefined();
    expect(withAccrued!.accrued!.items.length).toBeGreaterThan(0);
    expect(withAccrued!.accrued!.totalUsd).toBeNull();
    expect(withAccrued!.accrued!.note).toContain("24 hours");
  });

  it("omits accrued entirely when includeAccrued is false", async () => {
    const { data } = await run({ includeAccrued: false });
    expect(data.positions.every((leg) => leg.accrued === undefined)).toBe(true);
  });
});

describe("pendle.position.value — G-22: money format", () => {
  it("carries every balance as an exact {raw, decimals, exact} triplet", async () => {
    const { data } = await run();
    const pt = data.positions.find((leg) => leg.kind === "pt")!;

    expect(pt.balance).toEqual({
      raw: "1056635259419805288",
      decimals: 18,
      exact: "1.056635259419805288",
    });
    // The projector this replaces did Number(raw)/1e18 and lost the tail.
    expect(String(Number(pt.balance.raw) / 1e18)).not.toBe(pt.balance.exact);
  });

  it("reports UNKNOWN decimals rather than assuming 18", async () => {
    mockBuildAssetMap.mockResolvedValue(new Map());

    const { data } = await run();
    const leg = data.positions[0]!;
    expect(leg.balance.decimals).toBeNull();
    expect(leg.balance.exact).toBeNull();
  });

  it("totals USD exactly, and EXCLUDES legs it could not value while counting them", async () => {
    mockBuildAssetMap.mockResolvedValue(new Map());
    mockResolveMarketForRead.mockResolvedValue({ status: "not_found" });

    const { data } = await run();
    // Every leg still has a dashboard valuation, so nothing is lost here; the
    // arithmetic is what matters — a string total the rows add up to.
    expect(data.totalValueUsd).toMatch(/^\d+\.\d{2,6}$/);
    expect(data.valuedLegs + data.unvaluedLegs).toBe(data.count);
  });

  it("labels every USD figure with the basis it came from", async () => {
    const { data } = await run();
    for (const leg of data.positions) {
      expect(["accounting", "dashboard", "spot", "unknown"]).toContain(leg.valuationBasis);
    }
  });
});

describe("pendle.position.value — staleness and partial views", () => {
  it("reports per-chain data age and WARNS past 24 hours", async () => {
    const { data } = await run();
    const chain = data.chainFreshness.find((f) => f.chain === "ethereum")!;

    expect(chain.dataAsOf).toBe("2025-07-28T18:40:22.368Z");
    expect(chain.ageHours).toBeGreaterThan(24);
    expect(chain.stalenessWarning).toContain("day");
    expect(data.summary).toContain("STALE DATA");
  });

  it("NAMES a chain whose asset catalogue could not be read, and withholds its legs", async () => {
    mockBuildAssetMap.mockRejectedValue(new Error("catalogue unreadable"));

    const { data } = await run();
    expect(data.partial).toBe(true);
    // FLIPPED (owner decree 2026-08-02): the reason is the REAL cause, scrubbed
    // — "unexpected error" told the agent nothing about WHY the chain dropped out.
    expect(data.failedChains).toEqual([{ chain: "ethereum", reason: "catalogue unreadable" }]);
    expect(data.positions).toHaveLength(0);
  });

  it("REPORTS a holding on a chain outside the registry instead of dropping it", async () => {
    mockGetWalletPositions.mockResolvedValue({
      chains: [
        { chainId: 43114, updatedAt: null, totalOpen: 1, totalClosed: 0, totalSy: 0, open: [], sy: [] },
      ],
    });

    const { data } = await run();
    expect(data.unsupportedChains).toEqual([43114]);
    expect(data.partial).toBe(true);
  });
});

describe("pendle.position.value — one state vocabulary", () => {
  it("uses only the four documented states, and no redeemable/matured booleans", async () => {
    const { data } = await run();
    const serialized = JSON.stringify(data.positions);

    for (const leg of data.positions) {
      expect(["earning", "matured_redeemable", "matured_removable", "expired_worthless"]).toContain(leg.state);
    }
    expect(serialized).not.toContain('"redeemable"');
    expect(serialized).not.toContain('"matured"');
  });

  it("classifies a matured LP as removable and a matured YT as worthless", async () => {
    const { data } = await run();
    const byKind = new Map(data.positions.map((leg) => [`${leg.kind}:${leg.market}`, leg.state]));

    expect(byKind.get(`lp:${MATURED_MARKET}`)).toBe("matured_removable");
    expect(byKind.get(`yt:${MATURED_MARKET}`)).toBe("expired_worthless");
  });
});

describe("pendle.position.value — params", () => {
  it("passes minValueUsd through as the provider's own filterUsd", async () => {
    await run({ minValueUsd: 10 });
    expect(mockGetWalletPositions).toHaveBeenCalledWith(WALLET, { minUsd: 10 });
  });

  it("scopes by kind", async () => {
    const { data } = await run({ kinds: "pt" });
    expect(data.positions.every((leg) => leg.kind === "pt")).toBe(true);
  });

  it("keeps only the requested field groups", async () => {
    const { data } = await run({ fields: "identity,value" });
    expect(Object.keys(data.positions[0]!).sort()).toEqual([
      "chain",
      "kind",
      "market",
      "state",
      "stateDetermined",
      "token",
      "valuationBasis",
      "valueUsd",
    ]);
  });

  it("REFUSES an unknown kind by name before any network call", async () => {
    const result = await run({ kinds: "principal" });
    expect(result.success).toBe(false);
    expect(result.output).toContain("kinds");
    expect(mockGetWalletPositions).not.toHaveBeenCalled();
  });

  it("reports a dashboard outage as a failure, never as an empty portfolio", async () => {
    mockGetWalletPositions.mockRejectedValue(new Error("provider down"));

    const result = await run();
    expect(result.success).toBe(false);
    expect(result.output).toContain("Pendle positions unavailable");
  });
});

describe("pendle.position.value — cross-chain PT (NO non-empty live sample)", () => {
  it("reports a spoke-chain PT leg rather than letting it vanish", async () => {
    // FIXTURE GAP, stated plainly: `crossPtPositions` was EMPTY on all 326
    // wallets probed on 2026-07-27, consistent with Pendle listing zero spoke
    // markets. This case is SYNTHETIC — it proves the projection exists and is
    // shape-correct, NOT that it matches a real payload. Replace it with a
    // recorded body the day a spoke market lists.
    mockGetWalletPositions.mockResolvedValue({
      chains: [
        {
          chainId: 1,
          updatedAt: "2026-07-27T00:00:00.000Z",
          totalOpen: 1,
          totalClosed: 0,
          totalSy: 0,
          open: [
            {
              market: MATURED_MARKET,
              pt: null,
              yt: null,
              lp: null,
              crossPt: [{ spokePt: MATURED_PT, chainId: 43114, balanceRaw: "1000000000000000000" }],
            },
          ],
          sy: [],
        },
      ],
    });

    const { data } = await run();
    expect(data.crossPtPositions).toHaveLength(1);
    expect(data.crossPtPositions[0]).toMatchObject({
      chain: "ethereum",
      spokePt: MATURED_PT,
      spokeChainId: 43114,
      balanceRaw: "1000000000000000000",
    });
  });
});
