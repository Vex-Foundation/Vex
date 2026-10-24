/**
 * The analysis card's read, over an injected engine run.
 *
 * What is faked: `runTechnicalAnalysis` itself, because the engine and both
 * loaders are pinned by the root suite (`src/__tests__/vex-agent/market-analysis/`)
 * and a provider is not reachable from this suite. What is real: the venue
 * routing, the candle projection and its cap, the refusal wording, the shared
 * output schema the handler validates against, and the per-minute limiter.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TECHNICAL_ANALYSIS_CHART_MAX_CANDLES,
  technicalAnalysisReadOutputSchema,
} from "@shared/schemas/technical-analysis.js";
import {
  TECHNICAL_ANALYSIS_READS_PER_MINUTE,
  __resetTechnicalAnalysisReadLimiterForTests,
  readTechnicalAnalysis,
  type TechnicalAnalysisReadDeps,
} from "../technical-analysis-read.js";
import type { LoadCandles } from "@vex-agent/market-analysis/bars.js";
import type { TechnicalAnalysisInput, TechnicalAnalysisOutcome } from "@vex-agent/market-analysis/run.js";

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 20, 12);

function analysis() {
  return {
    ok: true as const,
    interval: "1h" as const,
    asOf: new Date(NOW).toISOString(),
    fetchedAt: new Date(NOW + 1_000).toISOString(),
    bars: 100,
    price: 319,
    changePct: 45,
    high: 320,
    low: 219,
    indicators: {
      ema20: 309.5, ema50: 294.5, ema200: 219.5, rsi14: 100, macd: 7, macdSignal: 7,
      macdHistogram: 0, bollingerUpper: 321, bollingerMiddle: 309.5, bollingerLower: 298, atr14: 2,
    },
    signals: {
      aboveEma20: true, aboveEma50: true, ema20AboveEma50: true,
      rsiZone: "overbought" as const, macdMomentum: "flat" as const, bollingerPosition: "upper_half" as const,
    },
    recent: [],
    closedCandles: { droppedForming: 1, gaps: 0, normalized: 0, unpriced: 0, sparse: false },
    source: "live_lighter_public_api",
  };
}

function closed(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    openTime: NOW - (n - i) * HOUR,
    closeTime: NOW - (n - 1 - i) * HOUR,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100 + i, volume: 1,
  }));
}

/**
 * A fake engine: `run` answers `outcome` and records every call in `calls`.
 * A vi.fn cannot stand in for the generic `run` itself, so the mock only
 * records and the function keeps the real signature.
 */
function deps(outcome: unknown) {
  const calls = vi.fn<(load: unknown, input: TechnicalAnalysisInput) => void>();
  const run: TechnicalAnalysisReadDeps["run"] = async <M,>(load: LoadCandles<M>, input: TechnicalAnalysisInput) => {
    calls(load, input);
    return outcome as TechnicalAnalysisOutcome<M>;
  };
  return { run, now: () => NOW, calls };
}

afterEach(() => __resetTechnicalAnalysisReadLimiterForTests());

describe("readTechnicalAnalysis", () => {
  it("returns the analysis with at most 260 closed candles, newest last, in the shared contract", async () => {
    const fake = deps({
      ok: true,
      market: { venue: "lighter", environment: "rhc", marketId: 0, symbol: "ETH", marketType: "perp" },
      analysis: analysis(),
      closed: closed(300),
    });
    const out = await readTechnicalAnalysis(
      { venue: "lighter", environment: "rhc", marketId: 0, interval: "1h", until: NOW },
      undefined,
      fake,
    );
    expect(technicalAnalysisReadOutputSchema.safeParse(out).success).toBe(true);
    if (!out.ok) throw new Error("expected an analysis");
    expect(out.candles).toHaveLength(TECHNICAL_ANALYSIS_CHART_MAX_CANDLES);
    expect(out.candles.at(-1)).toEqual({ t: NOW - HOUR, o: 399, h: 400, l: 398, c: 399 });
    expect(fake.calls.mock.calls[0]?.[1]).toEqual({ interval: "1h", untilMs: NOW });
  });

  it("drops the transport name from a DexScreener market", async () => {
    const fake = deps({
      ok: true,
      market: { venue: "dexscreener", chain: "base", pairAddress: "0xAbC", pairLabel: "A/B", transport: "site_bridge" },
      analysis: { ...analysis(), source: "dexscreener_site_bars" },
      closed: closed(40),
    });
    const out = await readTechnicalAnalysis(
      { venue: "dexscreener", chain: "base", pairAddress: "0xAbC", interval: "1h", bars: 30 },
      undefined,
      fake,
    );
    expect(technicalAnalysisReadOutputSchema.safeParse(out).success).toBe(true);
    expect(out).not.toHaveProperty("transport");
    expect(fake.calls.mock.calls[0]?.[1]).toEqual({ interval: "1h", bars: 30, untilMs: null });
  });

  it("answers a refusal as a value with its sentence, and never repeats a Lighter provider failure", async () => {
    const refused = await readTechnicalAnalysis(
      { venue: "lighter", environment: "core", marketId: 1, interval: "4h" },
      undefined,
      deps({ ok: false, reason: "source_unavailable", detail: "GET https://example.invalid failed", cause: new Error("x") }),
    );
    expect(refused).toEqual({
      ok: false,
      reason: "source_unavailable",
      message: "Lighter technical analysis unavailable (source_unavailable): the candle source did not answer.",
    });
  });

  it(`allows ${TECHNICAL_ANALYSIS_READS_PER_MINUTE} reads a minute and refuses the next with the wait`, async () => {
    const fake = deps({ ok: false, reason: "no_candles", detail: null });
    const input = { venue: "lighter" as const, environment: "rhc" as const, marketId: 0, interval: "1h" as const };
    for (let i = 0; i < TECHNICAL_ANALYSIS_READS_PER_MINUTE; i += 1) {
      await readTechnicalAnalysis(input, undefined, fake);
    }
    const limited = await readTechnicalAnalysis(input, undefined, fake);
    expect(limited).toMatchObject({ ok: false, reason: "source_unavailable" });
    expect((limited as { message: string }).message).toContain("try again in 60 seconds");
    expect(fake.calls).toHaveBeenCalledTimes(TECHNICAL_ANALYSIS_READS_PER_MINUTE);
  });
});
