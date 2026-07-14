import { describe, expect, it } from "vitest";

import {
  evaluateCandleScan,
  parseCandleScanFilters,
  type StoredHyperliquidCandle,
} from "@vex-agent/tools/protocols/hyperliquid/market-analysis.js";
import { parseHyperliquidCandleEvent } from "@tools/hyperliquid/subscriptions.js";

const candles = (rows: readonly Partial<StoredHyperliquidCandle>[]): readonly StoredHyperliquidCandle[] => rows.map((row, index) => ({
  coin: "BTC",
  interval: "1h",
  openTimeMs: index * 3_600_000,
  open: "100",
  high: "105",
  low: "95",
  close: "100",
  volume: "10",
  updatedAt: "2026-07-12T00:00:00.000Z",
  ...row,
}));

describe("Hyperliquid candle scan filters", () => {
  it("reports percent change, breakouts, range statistics, and malformed stored rows without using binary floats", () => {
    const result = evaluateCandleScan(candles([
      { close: "100", high: "101", low: "99" },
      { close: "110", high: "111", low: "99" },
      { close: "120", high: "120", low: "100" },
      { close: "not-a-decimal" },
    ]), parseCandleScanFilters({
      pctChange: { window: 3 },
      breakout: { lookback: 2 },
      rangeStats: { window: 3 },
    }));

    expect(result.skippedMalformed).toBe(1);
    expect(result.verdicts).toEqual(expect.objectContaining({
      pctChange: { window: 3, pct: "20" },
      breakout: { lookback: 2, direction: "above" },
      rangeStats: { window: 3, high: "120", low: "99", widthPct: expect.any(String) },
    }));
  });

  it("treats a close exactly equal to the earlier high or low as a breakout boundary", () => {
    const up = evaluateCandleScan(candles([
      { close: "100", high: "110", low: "90" },
      { close: "110", high: "110", low: "95" },
    ]), parseCandleScanFilters({ breakout: { lookback: 1 } }));
    const down = evaluateCandleScan(candles([
      { close: "100", high: "110", low: "90" },
      { close: "90", high: "105", low: "90" },
    ]), parseCandleScanFilters({ breakout: { lookback: 1 } }));

    expect(up.verdicts.breakout).toEqual({ lookback: 1, direction: "above" });
    expect(down.verdicts.breakout).toEqual({ lookback: 1, direction: "below" });
  });

  it("detects a volume spike at the factor edge and reports RSI extreme zones", () => {
    const result = evaluateCandleScan(candles([
      { close: "100", volume: "10" },
      { close: "101", volume: "10" },
      { close: "102", volume: "20" },
      { close: "103", volume: "20" },
      { close: "104", volume: "20" },
      { close: "105", volume: "40" },
    ]), parseCandleScanFilters({
      volumeSpike: { window: 5, factor: "2" },
      rsi: { period: 2 },
    }));

    expect(result.verdicts.volumeSpike).toEqual({ window: 5, factor: "2", spike: true });
    expect(result.verdicts.rsi).toEqual({ period: 2, value: "100", zone: "overbought" });
  });

  it("detects SMA and EMA crosses at the boundary candle", () => {
    const result = evaluateCandleScan(candles([
      { close: "100" },
      { close: "99" },
      { close: "98" },
      { close: "101" },
    ]), parseCandleScanFilters({
      smaCross: { fast: 2, slow: 3 },
      emaCross: { fast: 2, slow: 3 },
    }));

    expect(result.verdicts.smaCross).toEqual(expect.objectContaining({ direction: "bullish" }));
    expect(result.verdicts.emaCross).toEqual(expect.objectContaining({ direction: "bullish" }));
  });

  it("rejects malformed websocket candles before they can reach a watch", () => {
    expect(parseHyperliquidCandleEvent({ t: 1, s: "BTC", i: "1h", o: "1", h: "2", l: "0.5", c: "1.5", v: "10" }))
      .toMatchObject({ coin: "BTC", interval: "1h", openTimeMs: 1 });
    expect(() => parseHyperliquidCandleEvent({ t: 1, s: "BTC", i: "1h", o: "NaN", h: "2", l: "0.5", c: "1.5", v: "10" }))
      .toThrow();
  });
});
