/**
 * The technical analysis engine: the closed-candle rule, the bundle and the
 * runner, on synthetic bars whose expected readings follow from the
 * definitions by hand.
 *
 * A straight line is the workhorse: on `close = a + i` every EMA lags the
 * price by `(period - 1) / 2`, RSI is 100, MACD is
 * `(26 - 1) / 2 - (12 - 1) / 2 = 7`, the Bollinger middle is the SMA with a
 * population deviation of `sqrt((20^2 - 1) / 12)`, and with `high = close + 1`
 * and `low = close - 1` every true range is 2, so ATR is 2.
 */

import { describe, expect, it } from "vitest";

import { analyze, sig } from "../../../vex-agent/market-analysis/analyze.js";
import type { AnalysisBar, CandleLoadRequest, LoadedCandles } from "../../../vex-agent/market-analysis/bars.js";
import { closedBars } from "../../../vex-agent/market-analysis/closed.js";
import { barsToRead, runTechnicalAnalysis } from "../../../vex-agent/market-analysis/run.js";
import {
  ANALYSIS_INTERVAL_MS,
  lighterAnalysisResultSchema,
} from "../../../lib/market-analysis/result-schema.js";

const HOUR = ANALYSIS_INTERVAL_MS["1h"];
const T0 = Date.UTC(2026, 9, 1);

function bar(i: number, close: number, overrides: Partial<AnalysisBar> = {}): AnalysisBar {
  return {
    openTime: T0 + i * HOUR,
    closeTime: T0 + (i + 1) * HOUR,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 10,
    ...overrides,
  };
}

const line = (n: number, start = 100): AnalysisBar[] =>
  Array.from({ length: n }, (_, i) => bar(i, start + i));

describe("closedBars", () => {
  it("keeps a bar that closes exactly at the cut-off and drops one a millisecond later", () => {
    const bars = line(3);
    const cutoff = bars[1]!.closeTime;
    expect(closedBars(bars, cutoff, HOUR).bars).toHaveLength(2);
    const early = closedBars(bars, cutoff - 1, HOUR);
    expect(early.bars).toHaveLength(1);
    expect(early.droppedForming).toBe(2);
  });

  it("counts missing buckets and never fills them", () => {
    const bars = [bar(0, 10), bar(1, 11), bar(4, 14), bar(5, 15)];
    const result = closedBars(bars, T0 + 100 * HOUR, HOUR);
    expect(result.bars).toHaveLength(4);
    expect(result.gaps).toBe(2);
  });

  it("widens a high or low that does not cover the bar's own open and close, and counts it", () => {
    const bad = bar(0, 10, { open: 9, high: 9.5, low: 9.2, close: 10 });
    const result = closedBars([bad, bar(1, 11)], T0 + 10 * HOUR, HOUR);
    expect(result.normalized).toBe(1);
    expect(result.bars[0]).toMatchObject({ high: 10, low: 9 });
    expect(result.bars[1]).toMatchObject({ high: 12, low: 10 });
  });

  it("sorts oldest first and keeps the later row of a duplicate bucket", () => {
    const result = closedBars([bar(1, 11), bar(0, 10), bar(1, 12)], T0 + 10 * HOUR, HOUR);
    expect(result.bars.map((b) => b.close)).toEqual([10, 12]);
  });
});

describe("analyze", () => {
  it("reads a straight line the way the definitions say", () => {
    const bars = line(220);
    const result = analyze(bars, 100);
    // Price 319, the 100 bars shown start at close 220.
    expect(result.price).toBe(319);
    expect(result.changePct).toBe(45);
    expect(result.high).toBe(320);
    expect(result.low).toBe(219);
    expect(result.indicators.ema20).toBeCloseTo(309.5, 3);
    expect(result.indicators.ema50).toBeCloseTo(294.5, 3);
    expect(result.indicators.ema200).toBeCloseTo(219.5, 3);
    expect(result.indicators.rsi14).toBe(100);
    expect(result.indicators.macd).toBeCloseTo(7, 4);
    expect(result.indicators.macdSignal).toBeCloseTo(7, 4);
    expect(result.indicators.bollingerMiddle).toBeCloseTo(309.5, 3);
    expect(result.indicators.bollingerUpper).toBeCloseTo(309.5 + 2 * Math.sqrt(33.25), 3);
    expect(result.indicators.atr14).toBeCloseTo(2, 6);
    expect(result.signals).toMatchObject({
      aboveEma20: true,
      aboveEma50: true,
      ema20AboveEma50: true,
      rsiZone: "overbought",
      bollingerPosition: "upper_half",
    });
    expect(result.recent).toHaveLength(10);
    expect(result.recent.at(-1)).toMatchObject({
      close: 319,
      closeTime: new Date(bars.at(-1)!.closeTime).toISOString(),
      rsi14: 100,
    });
  });

  it("leaves a reading null, and its signal null, while it is still warming up", () => {
    const result = analyze(line(40), 40);
    expect(result.indicators.ema200).toBeNull();
    expect(result.indicators.ema50).toBeNull();
    expect(result.signals.aboveEma50).toBeNull();
    expect(result.signals.ema20AboveEma50).toBeNull();
    expect(result.indicators.ema20).not.toBeNull();
  });

  it("calls a sharp drop after a long rise bearish, oversold and below the band", () => {
    // 219 bars of +1, then one bar of -100: the 14-bar average gain is about
    // 13/14 against an average loss of 100/14, so RSI is about 11.5; the drop
    // is far outside a band whose deviation is under 6.
    const rise = line(219);
    const result = analyze([...rise, bar(219, 218)], 100);
    expect(result.signals.macdMomentum).toBe("bearish");
    expect(result.signals.rsiZone).toBe("oversold");
    expect(result.signals.aboveEma20).toBe(false);
    expect(result.signals.bollingerPosition).toBe("below_lower");
  });

  it("rounds to six significant digits", () => {
    expect(sig(1234.56789)).toBe(1234.57);
    expect(sig(0.000123456789)).toBe(0.000123457);
    expect(sig(Number.NaN)).toBeNull();
  });
});

function fakeLoader(bars: readonly AnalysisBar[], fetchedAtMs: number) {
  const requests: CandleLoadRequest[] = [];
  const load = async (request: CandleLoadRequest): Promise<LoadedCandles<{ venue: "lighter" }>> => {
    requests.push(request);
    return { ok: true, market: { venue: "lighter" }, bars, fetchedAtMs, unpriced: 1, source: "test_source" };
  };
  return { load, requests };
}

describe("runTechnicalAnalysis", () => {
  it("reads at least 220 bars, or bars + 60 when that is more", () => {
    expect(barsToRead(100)).toBe(220);
    expect(barsToRead(30)).toBe(220);
    expect(barsToRead(200)).toBe(260);
  });

  it("drops the forming bar, reports what it did, and names the newest closed bar", async () => {
    const bars = line(221);
    // The cut-off falls inside the last bar's bucket: it is still forming.
    const fetchedAtMs = bars[220]!.openTime + 1_000;
    const { load, requests } = fakeLoader(bars, fetchedAtMs);
    const outcome = await runTechnicalAnalysis(load, { interval: "1h" });
    expect(requests).toEqual([{ interval: "1h", count: 220, untilMs: null }]);
    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.closed).toHaveLength(220);
    expect(outcome.analysis.asOf).toBe(new Date(bars[219]!.closeTime).toISOString());
    expect(outcome.analysis.bars).toBe(100);
    expect(outcome.analysis.closedCandles).toEqual({
      droppedForming: 1,
      gaps: 0,
      normalized: 0,
      unpriced: 1,
      sparse: false,
    });
    expect(outcome.analysis.price).toBe(319);
    const parsed = lighterAnalysisResultSchema.safeParse({
      ...outcome.analysis,
      venue: "lighter",
      environment: "core",
      marketId: 1,
      symbol: "ETH",
      marketType: "perp",
    });
    expect(parsed.success).toBe(true);
  });

  it("cuts at `untilMs` when it is earlier than the fetch", async () => {
    const bars = line(260);
    const { load, requests } = fakeLoader(bars, bars[259]!.closeTime);
    const untilMs = bars[229]!.closeTime;
    const outcome = await runTechnicalAnalysis(load, { interval: "1h", bars: 50, untilMs });
    expect(requests[0]?.untilMs).toBe(untilMs);
    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.analysis.asOf).toBe(new Date(untilMs).toISOString());
    expect(outcome.analysis.closedCandles.droppedForming).toBe(30);
  });

  it("refuses fewer than 30 closed bars, and an empty answer", async () => {
    const short = fakeLoader(line(30), T0 + 29 * HOUR + 1);
    const refused = await runTechnicalAnalysis(short.load, { interval: "1h" });
    expect(refused).toMatchObject({ ok: false, reason: "not_enough_history" });
    const empty = fakeLoader([], T0);
    expect(await runTechnicalAnalysis(empty.load, { interval: "1h" })).toMatchObject({
      ok: false,
      reason: "no_candles",
    });
  });

  it("marks the window sparse when gaps exceed a tenth of it", async () => {
    const bars = line(220).filter((_, i) => i % 4 !== 0 || i === 0);
    const { load } = fakeLoader(bars, T0 + 1_000 * HOUR);
    const outcome = await runTechnicalAnalysis(load, { interval: "1h" });
    if (!outcome.ok) throw new Error("expected an analysis");
    expect(outcome.analysis.closedCandles.gaps).toBeGreaterThan(22);
    expect(outcome.analysis.closedCandles.sparse).toBe(true);
  });

  it("passes a loader refusal through and refuses an out-of-range bar count", async () => {
    const outcome = await runTechnicalAnalysis(
      async () => ({ ok: false, reason: "market_not_found", detail: "no such market" }),
      { interval: "4h" },
    );
    expect(outcome).toEqual({ ok: false, reason: "market_not_found", detail: "no such market" });
    const { load } = fakeLoader(line(220), T0);
    await expect(runTechnicalAnalysis(load, { interval: "1h", bars: 29 })).rejects.toThrow(RangeError);
    await expect(runTechnicalAnalysis(load, { interval: "1h", bars: 201 })).rejects.toThrow(RangeError);
  });
});
