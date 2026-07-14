/**
 * W14: the unbounded HL read tools (perp.markets, spot.markets, perp.fills,
 * perp.funding) now return a compact { returnedCount, matchedCount, truncated,
 * <items> } envelope — searchable / bounded so a no-arg call cannot overflow the
 * model's context and hide a market near the end of the raw universe (incident
 * 2026-07-13, CASHCAT). Model-facing decimals are canonicalized at the producer
 * boundary so the model cannot copy a trailing-zero value into a later param.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const mocks = vi.hoisted(() => ({
  meta: vi.fn(),
  metaAndAssetCtxs: vi.fn(),
  spotMeta: vi.fn(),
  spotMetaAndAssetCtxs: vi.fn(),
  userFills: vi.fn(),
  userFillsByTime: vi.fn(),
  userFunding: vi.fn(),
  resolveSelectedAddressForRead: vi.fn(),
}));

vi.mock("@tools/hyperliquid/info.js", () => ({
  HyperliquidInfoClient: class {
    meta = mocks.meta;
    metaAndAssetCtxs = mocks.metaAndAssetCtxs;
    spotMeta = mocks.spotMeta;
    spotMetaAndAssetCtxs = mocks.spotMetaAndAssetCtxs;
    userFills = mocks.userFills;
    userFillsByTime = mocks.userFillsByTime;
    userFunding = mocks.userFunding;
  },
}));

vi.mock("@vex-agent/tools/internal/wallet/resolve.js", () => ({
  resolveSelectedAddressForRead: mocks.resolveSelectedAddressForRead,
  walletScopeErrorToResult: (error: unknown) => { throw error; },
}));

const { HYPERLIQUID_HANDLERS } = await import(
  "@vex-agent/tools/protocols/hyperliquid/handlers.js"
);

const ADDRESS = "0x00000000000000000000000000000000000000ab";

function context(): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
  } as ProtocolExecutionContext;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveSelectedAddressForRead.mockReturnValue(ADDRESS);
});

async function callRaw(toolId: string, params: Record<string, unknown>): Promise<{ success: boolean; output: string; data?: Record<string, unknown> }> {
  const handler = HYPERLIQUID_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`Missing ${toolId} handler.`);
  const result = await handler(params, context());
  return result as { success: boolean; output: string; data?: Record<string, unknown> };
}

async function call(toolId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await callRaw(toolId, params);
  expect(result.success).toBe(true);
  return result.data as Record<string, unknown>;
}

const PERP_META = {
  universe: [
    { name: "BTC", maxLeverage: 50, szDecimals: 5 },
    { name: "ETH", maxLeverage: 25, szDecimals: 4 },
    { name: "CASHCAT", maxLeverage: 3, szDecimals: 0, onlyIsolated: true },
  ],
};
const PERP_CTXS = [
  { markPx: "62026.0", midPx: "62025.0", funding: "0.0001", openInterest: "1000", dayNtlVlm: "5000" },
  { markPx: "3000", midPx: "3000", funding: "0.0002", openInterest: "2000", dayNtlVlm: "9000" },
  { markPx: "0.5", midPx: "0.5", funding: "0.0003", openInterest: "10", dayNtlVlm: "50" },
];

function seedPerpMarkets(): void {
  mocks.meta.mockResolvedValue(PERP_META);
  mocks.metaAndAssetCtxs.mockResolvedValue([PERP_META, PERP_CTXS]);
}

describe("hyperliquid.perp.markets — search + bounded output", () => {
  it("finds one market by ticker substring and canonicalizes venue decimals", async () => {
    seedPerpMarkets();
    const data = await call("hyperliquid.perp.markets", { query: "cash" });
    const markets = data.markets as Array<Record<string, unknown>>;
    expect(data).toMatchObject({ returnedCount: 1, matchedCount: 1, truncated: false });
    // onlyIsolated tells the model upfront that marginMode:"cross" is invalid here.
    expect(markets[0]).toMatchObject({ coin: "CASHCAT", maxLeverage: 3, szDecimals: 0, markPx: "0.5", onlyIsolated: true });
  });

  it("marks cross-capable markets onlyIsolated=false", async () => {
    seedPerpMarkets();
    const data = await call("hyperliquid.perp.markets", { query: "btc" });
    expect((data.markets as Array<Record<string, unknown>>)[0]).toMatchObject({ coin: "BTC", onlyIsolated: false });
  });

  it("builds rows from a SINGLE metaAndAssetCtxs snapshot (no second meta fetch, no index drift)", async () => {
    mocks.metaAndAssetCtxs.mockResolvedValue([
      { universe: [{ name: "BTC" }, { name: "ETH" }] },
      [{ markPx: "100", openInterest: "2" }, { markPx: "200", openInterest: "1" }],
    ]);
    // A drifted second snapshot: if the handler zipped THIS universe with the
    // tuple contexts, BTC (index 1 here) would attach ETH's "200" mark.
    mocks.meta.mockResolvedValue({ universe: [{ name: "DOGE" }, { name: "BTC" }, { name: "ETH" }] });
    const data = await call("hyperliquid.perp.markets", {});
    const markets = data.markets as Array<Record<string, unknown>>;
    expect(mocks.meta).not.toHaveBeenCalled();
    expect(markets.map((m) => m.coin).sort()).toEqual(["BTC", "ETH"]);
    expect(markets.find((m) => m.coin === "BTC")?.markPx).toBe("100"); // tuple-aligned
  });

  it.each(["CASHCAT", "cashcat", "CaShCaT"])("matches CASHCAT case-insensitively for query %s", async (query) => {
    seedPerpMarkets();
    const data = await call("hyperliquid.perp.markets", { query });
    expect((data.markets as Array<Record<string, unknown>>).map((m) => m.coin)).toEqual(["CASHCAT"]);
  });

  it("orders by open interest and canonicalizes the trailing-zero mark when no query", async () => {
    seedPerpMarkets();
    const data = await call("hyperliquid.perp.markets", {});
    const markets = data.markets as Array<Record<string, unknown>>;
    expect(markets.map((m) => m.coin)).toEqual(["ETH", "BTC", "CASHCAT"]);
    expect(data.matchedCount).toBe(3);
    expect(data.truncated).toBe(false);
    // The venue's "62026.0" is canonicalized so the model cannot copy a
    // trailing-zero value into a later price param.
    expect(markets.find((m) => m.coin === "BTC")?.markPx).toBe("62026");
  });

  it("breaks liquidity ties by coin ascending (deterministic pagination)", async () => {
    const meta = { universe: [{ name: "ZED" }, { name: "ABE" }, { name: "MID" }] };
    mocks.meta.mockResolvedValue(meta);
    mocks.metaAndAssetCtxs.mockResolvedValue([
      meta,
      [{ openInterest: "100" }, { openInterest: "100" }, { openInterest: "100" }],
    ]);
    const data = await call("hyperliquid.perp.markets", {});
    expect((data.markets as Array<Record<string, unknown>>).map((m) => m.coin)).toEqual(["ABE", "MID", "ZED"]);
  });

  it("respects the limit and still reports the true match count and truncation", async () => {
    seedPerpMarkets();
    const data = await call("hyperliquid.perp.markets", { limit: 2 });
    const markets = data.markets as Array<Record<string, unknown>>;
    expect(markets.map((m) => m.coin)).toEqual(["ETH", "BTC"]);
    expect(data).toMatchObject({ returnedCount: 2, matchedCount: 3, truncated: true });
  });

  it("clamps a limit above the hard cap of 50", async () => {
    const meta = { universe: Array.from({ length: 120 }, (_, i) => ({ name: `C${i}` })) };
    mocks.meta.mockResolvedValue(meta);
    mocks.metaAndAssetCtxs.mockResolvedValue([meta, Array.from({ length: 120 }, (_, i) => ({ markPx: "1", openInterest: String(i) }))]);
    const data = await call("hyperliquid.perp.markets", { limit: 999 });
    expect((data.markets as unknown[]).length).toBe(50);
    expect(data).toMatchObject({ matchedCount: 120, truncated: true });
  });

  it("rejects an empty query and a non-positive limit with a clean error", async () => {
    seedPerpMarkets();
    expect((await callRaw("hyperliquid.perp.markets", { query: "   " })).success).toBe(false);
    const zero = await callRaw("hyperliquid.perp.markets", { limit: 0 });
    expect(zero.success).toBe(false);
    expect(zero.output).toMatch(/limit/i);
  });
});

describe("hyperliquid.spot.markets — search + bounded output", () => {
  const SPOT_META = { universe: [{ name: "PURR/USDC" }, { name: "HYPE/USDC" }], tokens: [] };
  const SPOT_CTXS = [
    { coin: "PURR/USDC", markPx: "0.30", midPx: "0.30", prevDayPx: "0.31", dayNtlVlm: "100" },
    { coin: "HYPE/USDC", markPx: "25.0", midPx: "25.0", prevDayPx: "24", dayNtlVlm: "9000" },
  ];

  function seed(): void {
    mocks.spotMeta.mockResolvedValue(SPOT_META);
    mocks.spotMetaAndAssetCtxs.mockResolvedValue([SPOT_META, SPOT_CTXS]);
  }

  it("filters by pair name and canonicalizes decimals", async () => {
    seed();
    const data = await call("hyperliquid.spot.markets", { query: "purr" });
    const markets = data.markets as Array<Record<string, unknown>>;
    expect(data).toMatchObject({ returnedCount: 1, matchedCount: 1, truncated: false });
    expect(markets[0]).toMatchObject({ coin: "PURR/USDC", markPx: "0.3" });
  });

  it.each(["PURR/USDC", "purr/usdc", "PuRr"])("matches the PURR pair case-insensitively for query %s", async (query) => {
    seed();
    const data = await call("hyperliquid.spot.markets", { query });
    expect((data.markets as Array<Record<string, unknown>>).map((m) => m.coin)).toEqual(["PURR/USDC"]);
  });

  it("volume-orders the default view", async () => {
    seed();
    const data = await call("hyperliquid.spot.markets", {});
    expect((data.markets as Array<Record<string, unknown>>).map((m) => m.coin)).toEqual(["HYPE/USDC", "PURR/USDC"]);
    expect(data.matchedCount).toBe(2);
  });

  it("rejects an empty query", async () => {
    seed();
    expect((await callRaw("hyperliquid.spot.markets", { query: "" })).success).toBe(false);
  });

  it("builds spot rows from a SINGLE spotMetaAndAssetCtxs snapshot (no second spotMeta fetch)", async () => {
    mocks.spotMetaAndAssetCtxs.mockResolvedValue([
      { universe: [{ name: "PURR/USDC" }, { name: "HYPE/USDC" }] },
      [{ coin: "PURR/USDC", markPx: "0.3", dayNtlVlm: "5" }, { coin: "HYPE/USDC", markPx: "25", dayNtlVlm: "9" }],
    ]);
    mocks.spotMeta.mockResolvedValue({ universe: [{ name: "X/USDC" }, { name: "PURR/USDC" }, { name: "HYPE/USDC" }] });
    const data = await call("hyperliquid.spot.markets", { query: "purr" });
    expect(mocks.spotMeta).not.toHaveBeenCalled();
    expect((data.markets as Array<Record<string, unknown>>)[0]).toMatchObject({ coin: "PURR/USDC", markPx: "0.3" });
  });
});

describe("hyperliquid.perp.fills — newest-first, bounded", () => {
  it("sorts newest-first, caps at the limit, canonicalizes decimals, and reports truncation", async () => {
    mocks.userFills.mockResolvedValue([
      { time: 300, coin: "BTC", px: "62000.0", sz: "0.1", side: "B" },
      { time: 100, coin: "ETH", px: "3000", sz: "1", side: "A" },
      { time: 200, coin: "SOL", px: "150", sz: "2", side: "B" },
    ]);
    const data = await call("hyperliquid.perp.fills", { limit: 2 });
    const fills = data.fills as Array<Record<string, unknown>>;
    expect(fills.map((f) => f.time)).toEqual([300, 200]);
    expect(fills[0]?.px).toBe("62000"); // canonicalized
    expect(data).toMatchObject({ returnedCount: 2, matchedCount: 3, truncated: true });
  });

  it("composes startTime (venue-scoped) with limit", async () => {
    mocks.userFillsByTime.mockResolvedValue([{ time: 300, coin: "BTC" }, { time: 280, coin: "ETH" }]);
    const data = await call("hyperliquid.perp.fills", { startTime: 250, limit: 5 });
    expect(mocks.userFillsByTime).toHaveBeenCalledWith(ADDRESS, 250);
    expect(mocks.userFills).not.toHaveBeenCalled();
    expect(data.matchedCount).toBe(2);
    expect((data.fills as Array<Record<string, unknown>>).map((f) => f.time)).toEqual([300, 280]);
  });

  it("rejects a non-positive limit and a negative startTime", async () => {
    mocks.userFills.mockResolvedValue([]);
    expect((await callRaw("hyperliquid.perp.fills", { limit: 0 })).success).toBe(false);
    expect((await callRaw("hyperliquid.perp.fills", { startTime: -1 })).success).toBe(false);
  });
});

describe("hyperliquid.perp.funding — newest-first, bounded", () => {
  it("applies a startTime lower bound, sorts newest-first, canonicalizes, and caps", async () => {
    mocks.userFunding.mockResolvedValue([
      { time: 100, delta: { coin: "BTC", usdc: "-0.10", szi: "-0.50", fundingRate: "0.0000125" } },
      { time: 300, delta: { coin: "BTC", usdc: "-0.30", szi: "-0.50", fundingRate: "0.0000125" } },
      { time: 200, delta: { coin: "BTC", usdc: "-0.20", szi: "-0.50", fundingRate: "0.0000125" } },
    ]);
    const data = await call("hyperliquid.perp.funding", { startTime: 150, limit: 5 });
    const funding = data.funding as Array<Record<string, unknown>>;
    expect(funding.map((f) => f.time)).toEqual([300, 200]); // 100 excluded by startTime
    expect(funding[0]).toMatchObject({ usdc: "-0.3", szi: "-0.5" }); // canonicalized signed decimals
    expect(data).toMatchObject({ returnedCount: 2, matchedCount: 2, truncated: false });
  });
});
