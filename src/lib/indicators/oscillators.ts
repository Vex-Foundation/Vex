/**
 * RSI and MACD.
 *
 * RSI is Wilder's: the first average gain and loss are the simple averages of
 * the first `period` changes, later ones are smoothed by `(period - 1) / period`,
 * and a series with no movement at all reads 50. Moved verbatim from the
 * Lighter desk's chart studies.
 *
 * MACD is lifted out of the desk's `computeStudies` with the same arithmetic:
 * the signal line is an EMA over the MACD values that exist (the warm-up nulls
 * compacted away), laid back onto the MACD's own indices. That puts the first
 * signal at index `slow + signal - 2`, not `slow + signal - 1`.
 */

import { ema } from "./moving-average.js";
import { assertPeriod, type Series } from "./series.js";

export function rsi(values: readonly number[], period = 14): Series {
  assertPeriod(period);
  let gain = 0;
  let loss = 0;
  return values.map((value, i) => {
    if (i === 0)
      return null;
    const change = value - values[i - 1]!;
    if (i <= period) {
      gain += Math.max(0, change) / period;
      loss += Math.max(0, -change) / period;
    }
    else {
      gain = (gain * (period - 1) + Math.max(0, change)) / period;
      loss = (loss * (period - 1) + Math.max(0, -change)) / period;
    }
    return i < period ? null : loss === 0 ? gain === 0 ? 50 : 100 : 100 - 100 / (1 + gain / loss);
  });
}

export interface MacdSeries {
  readonly macd: Series;
  readonly signal: Series;
  readonly histogram: Series;
}

export function macd(values: readonly number[], fast = 12, slow = 26, signalPeriod = 9): MacdSeries {
  assertPeriod(fast);
  assertPeriod(slow);
  assertPeriod(signalPeriod);
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line = fastLine.map((value, i) => value === null || slowLine[i] === null ? null : value - slowLine[i]!);
  const compactSignal = ema(line.filter((value): value is number => value !== null), signalPeriod);
  let signalIndex = 0;
  const signal = line.map(value => value === null ? null : compactSignal[signalIndex++]!);
  const histogram = line.map((v, i) => v === null || signal[i] === null ? null : v - signal[i]!);
  return { macd: line, signal, histogram };
}
