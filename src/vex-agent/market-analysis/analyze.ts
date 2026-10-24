/**
 * The fixed indicator bundle over closed bars.
 *
 * The indicators run over EVERY closed bar read (the warm-up included), so the
 * slow ones are warm on the first bar shown; the price facts (price, change,
 * high, low) cover only the `shown` newest bars the caller asked for. There is
 * no indicator selection: one bundle, so two answers about the same market
 * and interval are always comparable.
 *
 * Signals use the conventional thresholds: RSI at or above 70 is overbought
 * and at or below 30 oversold; MACD momentum is the histogram's sign; the
 * Bollinger position compares the price with the bands and the middle line.
 * Numbers are rounded to six significant digits. This is analysis, never
 * money math: nothing here sizes or prices an order.
 */

import {
  atr,
  bollinger,
  ema,
  lastValue,
  macd,
  rsi,
} from "../../lib/indicators/index.js";
import {
  ANALYSIS_RECENT_BARS,
  type AnalysisIndicators,
  type AnalysisSignals,
} from "../../lib/market-analysis/result-schema.js";

import type { AnalysisBar } from "./bars.js";

export interface AnalysisBundle {
  readonly price: number;
  readonly changePct: number | null;
  readonly high: number;
  readonly low: number;
  readonly indicators: AnalysisIndicators;
  readonly signals: AnalysisSignals;
  readonly recent: {
    readonly closeTime: string;
    readonly close: number;
    readonly rsi14: number | null;
    readonly macdHistogram: number | null;
  }[];
}

/** Six significant digits; a non-finite value is `null`. */
export function sig(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toPrecision(6));
}

function required(value: number | null): number {
  const rounded = sig(value);
  if (rounded === null) throw new RangeError("Analysis price is not a finite number");
  return rounded;
}

function compare(a: number | null, b: number | null): boolean | null {
  return a === null || b === null ? null : a > b;
}

/** `bars` is non-empty and every price is finite (the loaders guarantee both). */
export function analyze(bars: readonly AnalysisBar[], shown: number): AnalysisBundle {
  const close = bars.map((bar) => bar.close);
  const ema20 = ema(close, 20);
  const ema50 = ema(close, 50);
  const ema200 = ema(close, 200);
  const rsi14 = rsi(close, 14);
  const lines = macd(close, 12, 26, 9);
  const bands = bollinger(close, 20, 2);
  const atr14 = atr(bars, 14);

  const window = bars.slice(-shown);
  const price = window[window.length - 1]!.close;
  const first = window[0]!.close;
  const e20 = lastValue(ema20);
  const e50 = lastValue(ema50);
  const r = lastValue(rsi14);
  const histogram = lastValue(lines.histogram);
  const upper = lastValue(bands.upper);
  const middle = lastValue(bands.middle);
  const lower = lastValue(bands.lower);

  const offset = bars.length - Math.min(ANALYSIS_RECENT_BARS, bars.length);
  return {
    price: required(price),
    changePct: first === 0 ? null : sig(((price - first) / first) * 100),
    high: required(Math.max(...window.map((bar) => bar.high))),
    low: required(Math.min(...window.map((bar) => bar.low))),
    indicators: {
      ema20: sig(e20),
      ema50: sig(e50),
      ema200: sig(lastValue(ema200)),
      rsi14: sig(r),
      macd: sig(lastValue(lines.macd)),
      macdSignal: sig(lastValue(lines.signal)),
      macdHistogram: sig(histogram),
      bollingerUpper: sig(upper),
      bollingerMiddle: sig(middle),
      bollingerLower: sig(lower),
      atr14: sig(lastValue(atr14)),
    },
    signals: {
      aboveEma20: compare(price, e20),
      aboveEma50: compare(price, e50),
      ema20AboveEma50: compare(e20, e50),
      rsiZone: r === null ? null : r >= 70 ? "overbought" : r <= 30 ? "oversold" : "neutral",
      macdMomentum:
        histogram === null ? null : histogram > 0 ? "bullish" : histogram < 0 ? "bearish" : "flat",
      bollingerPosition:
        upper === null || middle === null || lower === null
          ? null
          : price > upper
            ? "above_upper"
            : price < lower
              ? "below_lower"
              : price >= middle
                ? "upper_half"
                : "lower_half",
    },
    recent: bars.slice(offset).map((bar, i) => ({
      closeTime: new Date(bar.closeTime).toISOString(),
      close: required(bar.close),
      rsi14: sig(rsi14[offset + i] ?? null),
      macdHistogram: sig(lines.histogram[offset + i] ?? null),
    })),
  };
}
