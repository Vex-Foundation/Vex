/**
 * Bollinger bands, true range and ATR.
 *
 * Bollinger is lifted out of the Lighter desk's `computeStudies` with the same
 * arithmetic: the middle band is the SMA and the deviation is the POPULATION
 * standard deviation of the same window (divided by `period`, not
 * `period - 1`), the convention Bollinger himself and StockCharts use.
 *
 * ATR follows Wilder's published definition. The first bar's true range is
 * its high minus its low (there is no previous close yet); every later bar's
 * is the largest of high minus low and the distances from the previous close
 * to the high and to the low. The first ATR is the simple average of the
 * first `period` true ranges, at index `period - 1`; each later one is
 * `(previous * (period - 1) + trueRange) / period`.
 */

import { sma } from "./moving-average.js";
import { assertPeriod, type PriceBar, type Series } from "./series.js";

export interface BollingerSeries {
  readonly middle: Series;
  readonly upper: Series;
  readonly lower: Series;
}

export function bollinger(values: readonly number[], period = 20, multiplier = 2): BollingerSeries {
  if (!Number.isFinite(multiplier) || multiplier < 0)
    throw new RangeError("Invalid multiplier");
  const middle = sma(values, period);
  const deviations = middle.map((value, i) => value === null ? null : Math.sqrt(values.slice(i - period + 1, i + 1).reduce((sum, close) => sum + (close - value) ** 2, 0) / period));
  return {
    middle,
    upper: middle.map((v, i) => v === null ? null : v + multiplier * deviations[i]!),
    lower: middle.map((v, i) => v === null ? null : v - multiplier * deviations[i]!),
  };
}

export function trueRange(bars: readonly PriceBar[]): number[] {
  return bars.map((bar, i) => {
    const range = bar.high - bar.low;
    if (i === 0)
      return range;
    const previousClose = bars[i - 1]!.close;
    return Math.max(range, Math.abs(bar.high - previousClose), Math.abs(bar.low - previousClose));
  });
}

export function atr(bars: readonly PriceBar[], period = 14): Series {
  assertPeriod(period);
  const ranges = trueRange(bars);
  let sum = 0;
  let previous: number | null = null;
  return ranges.map((range, i) => {
    if (i < period - 1) {
      sum += range;
      return null;
    }
    previous = previous === null ? (sum + range) / period : (previous * (period - 1) + range) / period;
    return previous;
  });
}
