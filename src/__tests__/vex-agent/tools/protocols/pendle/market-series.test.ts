/**
 * `pendle.market.history` and `pendle.market.candles` — the two time-series reads.
 *
 * They share this file because they share the contract that matters: a window is
 * bounded and echoed, a field carries its unit in its NAME, and a gap in the data
 * stays a gap. The specific traps each one encodes are live-verified:
 *
 *  - history returns ROW OBJECTS and only serves 17 of the documented fields, so
 *    the field list is a closed allowlist and is sent explicitly (the provider
 *    default set costs 4x the compute units of a narrow one);
 *  - candles arrive as CSV inside JSON with a legitimately EMPTY trailing volume
 *    column, and for LP assets Pendle documents volume as always 0 — a volume of
 *    `null` must never be rendered as a measured zero;
 *  - the candles endpoint takes ISO REQUEST bounds while its rows carry unix
 *    seconds. Sending seconds is a live 400.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ErrorCodes, VexError } from "../../../../../errors.js";

vi.mock("@utils/logger.js", () => ({
  default: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

const mockGetMarketHistory = vi.fn();
const mockGetAssetCandles = vi.fn();
vi.mock("@tools/pendle/read/client.js", () => ({
  getPendleReadClient: () => ({
    getMarketHistory: (...a: unknown[]) => mockGetMarketHistory(...a),
    getAssetCandles: (...a: unknown[]) => mockGetAssetCandles(...a),
  }),
}));

const { validatePendleMarketHistory } = await import("@tools/pendle/read/validation/market-detail.js");
const { validatePendleCandles } = await import("@tools/pendle/read/validation/price-series.js");
const { pendleMarketHistory } = await import("@vex-agent/tools/protocols/pendle/handlers/market-history.js");
const { pendleMarketCandles } = await import("@vex-agent/tools/protocols/pendle/handlers/market-candles.js");
const { PENDLE_MARKET_HISTORY, PENDLE_ASSET_OHLCV } = await import("./read-surface-fixtures.js");

const MARKET = "0x34280882267ffa6383b363e278b027be083bbe3b";
const PT = "0xb253eff1104802b97ac7e3ac9fdd73aece295a2c";
const NOW = Date.parse("2026-07-27T12:00:00.000Z");

const liveHistory = validatePendleMarketHistory(PENDLE_MARKET_HISTORY, ["impliedApy", "tvl", "ptPrice"]);
const liveCandles = validatePendleCandles(PENDLE_ASSET_OHLCV);

function output(result: { success: boolean; data?: Record<string, unknown> }): Record<string, unknown> {
  if (!result.success || result.data === undefined) {
    throw new Error(`expected a successful read, got: ${JSON.stringify(result)}`);
  }
  return result.data;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMarketHistory.mockResolvedValue(liveHistory);
  mockGetAssetCandles.mockResolvedValue(liveCandles);
});

describe("pendle.market.history", () => {
  const params = {
    chain: "ethereum",
    market: MARKET,
    timeFrame: "day",
    fields: "impliedApy,tvl,ptPrice",
    from: "2026-07-20T00:00:00.000Z",
    to: "2026-07-27T00:00:00.000Z",
  };

  it("sends exactly the requested fields and ISO window — never the costly default set", async () => {
    await pendleMarketHistory(params, NOW);
    expect(mockGetMarketHistory).toHaveBeenCalledWith(1, MARKET, {
      timeFrame: "day",
      fields: ["impliedApy", "tvl", "ptPrice"],
      timestampStart: "2026-07-20T00:00:00.000Z",
      timestampEnd: "2026-07-27T00:00:00.000Z",
    });
  });

  it("projects each point with the unit in the field name", async () => {
    const data = output(await pendleMarketHistory(params, NOW));
    expect(data.count).toBe(8);
    expect(data.total).toBe(8);
    expect(data.truncated).toBe(false);

    const points = data.points as Array<Record<string, unknown>>;
    expect(points[0]).toEqual({
      timestamp: "2026-07-20T00:00:00.000Z",
      impliedApyPercent: "2.27",
      tvlUsd: "3465165.457215",
      ptPriceUsd: "1838.237217",
    });
  });

  it("computes min/max/first/last and the relative change locally, per requested field", async () => {
    const data = output(await pendleMarketHistory(params, NOW));
    const stats = data.stats as Record<string, Record<string, unknown>>;

    expect(stats.tvlUsd).toEqual({
      min: "3391723.352003",
      max: "3567969.85019",
      first: "3465165.457215",
      last: "3542391.757133",
      changePercent: "2.23",
    });
    expect(stats.impliedApyPercent).toMatchObject({ first: "2.27", last: "2.28" });
  });

  it("echoes the applied window the provider reports, next to the one that was asked for", async () => {
    const data = output(await pendleMarketHistory(params, NOW));
    expect(data.requestedWindow).toEqual({ from: "2026-07-20T00:00:00.000Z", to: "2026-07-27T00:00:00.000Z" });
    expect(data.appliedWindow).toEqual({ from: "2026-07-20T00:00:00.000Z", to: "2026-07-27T00:00:00.000Z" });
  });

  it("refuses an out-of-domain field BY NAME before any provider call", async () => {
    const result = await pendleMarketHistory({ ...params, fields: "impliedApy,liquidity" }, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("liquidity");
    expect(mockGetMarketHistory).not.toHaveBeenCalled();
  });

  it("turns a definitive 404 into an actionable refusal, not a retry hint", async () => {
    const notFound = new VexError(ErrorCodes.PENDLE_MARKET_NOT_FOUND, "Pendle has no history (HTTP 404).");
    notFound.httpStatus = 404;
    mockGetMarketHistory.mockRejectedValue(notFound);

    const result = await pendleMarketHistory(params, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("pendle__market_get");
    expect(result.output.toLowerCase()).not.toContain("retry");
  });

  it("reports an empty series as an empty series, with no invented statistics", async () => {
    mockGetMarketHistory.mockResolvedValue({ total: 0, timestampStart: null, timestampEnd: null, points: [] });
    const data = output(await pendleMarketHistory(params, NOW));
    expect(data.count).toBe(0);
    expect(data.stats).toEqual({});
    expect(String(data.summary).toLowerCase()).toContain("no points");
  });
});

describe("pendle.market.candles", () => {
  const params = { chain: "ethereum", asset: PT, timeFrame: "day", from: "2026-07-20T00:00:00.000Z" };

  it("passes the window as ISO — the form this endpoint requires on request", async () => {
    await pendleMarketCandles(params, NOW);
    expect(mockGetAssetCandles).toHaveBeenCalledWith(1, PT, {
      timeFrame: "day",
      timestampStart: "2026-07-20T00:00:00.000Z",
    });
  });

  it("re-serialises the unix-second row timestamps into ISO and keeps prices intact", async () => {
    const data = output(await pendleMarketCandles(params, NOW));
    const candles = data.candles as Array<Record<string, unknown>>;
    expect(data.count).toBe(8);
    expect(candles[0]).toEqual({
      time: "2026-07-20T00:00:00.000Z",
      open: 1812.6885,
      high: 1850.6601,
      low: 1789.9877,
      close: 1838.2372,
      volume: 0.1912,
    });
  });

  it("keeps an unrecorded volume NULL and explains it instead of showing a measured zero", async () => {
    const data = output(await pendleMarketCandles(params, NOW));
    const candles = data.candles as Array<Record<string, unknown>>;
    expect(candles[1]?.volume).toBeNull();
    // FOUR rows of the recorded CSV carry an empty trailing volume column
    // (rows 2-5). The fixture's own doc comment says three — the bytes win.
    expect(data.candlesWithoutVolume).toBe(4);
    expect(String(data.volumeNote)).toMatch(/no recorded trades/i);
    // Pendle documents LP volume on this endpoint as always 0 — the agent must be
    // sent to the market series for the real figure rather than concluding "no volume".
    expect(String(data.volumeNote)).toContain("pendle__market_history_get");
  });

  it("summarises the window with the first and last close", async () => {
    const data = output(await pendleMarketCandles(params, NOW));
    expect(data.firstClose).toBe(1838.2372);
    expect(data.lastClose).toBe(1879.0333);
    expect(data.currency).toBe("USD");
    expect(data.truncated).toBe(false);
  });

  it("surfaces the read shelf's row cap as an EXPLICIT truncation", async () => {
    mockGetAssetCandles.mockResolvedValue({ ...liveCandles, total: 9000, truncated: true });
    const data = output(await pendleMarketCandles(params, NOW));
    expect(data.truncated).toBe(true);
    expect(String(data.truncationNote)).toMatch(/narrow/i);
  });

  it("refuses a window that would exceed the row bound BY NAME, before any provider call", async () => {
    const result = await pendleMarketCandles({ ...params, timeFrame: "hour", from: "2025-01-01T00:00:00.000Z" }, NOW);
    expect(result.success).toBe(false);
    expect(result.output).toContain("1440");
    expect(mockGetAssetCandles).not.toHaveBeenCalled();
  });
});
