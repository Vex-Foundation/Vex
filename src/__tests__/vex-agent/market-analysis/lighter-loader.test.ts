/**
 * The Lighter candle loader: the request it sends and the bars it maps,
 * against a fake client. The live read is in
 * `src/__tests__/lighter/lighter-live-market-data.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import {
  createLighterCandleLoader,
  type LighterAnalysisClient,
} from "../../../vex-agent/market-analysis/lighter-loader.js";
import type { LighterCandle, LighterMarketDetail, LighterMarketType } from "../../../tools/lighter/types.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12, 30);

function candle(t: number, close: number, extra: Partial<LighterCandle> = {}): LighterCandle {
  return { t, o: close, h: close + 1, l: close - 1, c: close, v: 2, V: 200, i: "1", ...extra };
}

function marketDetail(marketType: LighterMarketType): LighterMarketDetail {
  return {
    symbol: "ETH",
    market_id: 1,
    market_type: marketType,
    base_asset_id: 1,
    quote_asset_id: 3,
    status: "active",
    taker_fee: "0",
    maker_fee: "0",
    liquidation_fee: "0",
    min_base_amount: "0.005",
    min_quote_amount: "10",
    supported_size_decimals: 4,
    supported_price_decimals: 2,
    supported_quote_decimals: 6,
    order_quote_limit: "0",
    is_maker_fee_enabled: false,
    is_taker_fee_enabled: false,
  };
}

function fakeClient(candles: LighterCandle[], marketType: LighterMarketType = "perp") {
  const detail = marketDetail(marketType);
  return {
    getMarketDetails: vi.fn<LighterAnalysisClient["getMarketDetails"]>(async () => ({
      code: 200,
      order_book_details: marketType === "perp" ? [detail] : [],
      spot_order_book_details: marketType === "spot" ? [detail] : [],
    })),
    getCandles: vi.fn<LighterAnalysisClient["getCandles"]>(async () => ({ code: 200, r: "1h", c: candles })),
  };
}

describe("createLighterCandleLoader", () => {
  it("asks for count bars ending now, with open timestamps", async () => {
    const client = fakeClient([]);
    const load = createLighterCandleLoader({ environment: "rhc", marketId: 1 }, client, () => NOW);
    await load({ interval: "1h", count: 220, untilMs: null });
    expect(client.getCandles).toHaveBeenCalledWith("rhc", {
      marketId: 1,
      resolution: "1h",
      startTimestamp: NOW - 220 * HOUR,
      endTimestamp: NOW,
      countBack: 220,
      setTimestampToEnd: false,
    });
    expect(client.getMarketDetails).toHaveBeenCalledWith("rhc", { marketId: 1, filter: "all" });
  });

  it("ends the read at untilMs when one is given", async () => {
    const client = fakeClient([]);
    const load = createLighterCandleLoader({ environment: "core", marketId: 1 }, client, () => NOW);
    await load({ interval: "4h", count: 220, untilMs: NOW - 10 * HOUR });
    expect(client.getCandles.mock.calls[0]?.[1]).toMatchObject({ endTimestamp: NOW - 10 * HOUR });
  });

  it("maps open-time rows to bars, normalising seconds and counting unpriced rows", async () => {
    const open = NOW - 2 * HOUR;
    const client = fakeClient([
      candle(open / 1000, 10),
      candle(open + HOUR, 11),
      candle(open + 2 * HOUR, Number.NaN),
    ], "spot");
    const load = createLighterCandleLoader({ environment: "core", marketId: 1 }, client, () => NOW);
    const loaded = await load({ interval: "1h", count: 220, untilMs: null });
    if (!loaded.ok) throw new Error("expected candles");
    expect(loaded.market).toEqual({
      venue: "lighter",
      environment: "core",
      marketId: 1,
      symbol: "ETH",
      marketType: "spot",
    });
    expect(loaded.bars).toEqual([
      { openTime: open, closeTime: open + HOUR, open: 10, high: 11, low: 9, close: 10, volume: 200 },
      { openTime: open + HOUR, closeTime: open + 2 * HOUR, open: 11, high: 12, low: 10, close: 11, volume: 200 },
    ]);
    expect(loaded.unpriced).toBe(1);
    expect(loaded.fetchedAtMs).toBe(NOW);
  });

  it("refuses a market the details do not list", async () => {
    const client = fakeClient([]);
    client.getMarketDetails.mockResolvedValueOnce({
      code: 200,
      order_book_details: [],
      spot_order_book_details: [],
    });
    const load = createLighterCandleLoader({ environment: "rhc", marketId: 7 }, client, () => NOW);
    expect(await load({ interval: "1h", count: 220, untilMs: null })).toMatchObject({
      ok: false,
      reason: "market_not_found",
    });
  });

  it("answers source_unavailable with the cause when a read fails", async () => {
    const client = fakeClient([]);
    const cause = new Error("timeout");
    client.getCandles.mockRejectedValueOnce(cause);
    const load = createLighterCandleLoader({ environment: "rhc", marketId: 1 }, client, () => NOW);
    expect(await load({ interval: "1h", count: 220, untilMs: null })).toEqual({
      ok: false,
      reason: "source_unavailable",
      detail: null,
      cause,
    });
  });
});
