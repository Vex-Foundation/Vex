/**
 * Simple and exponential moving averages.
 *
 * Moved verbatim from the Lighter desk's chart studies, so the desk and the
 * engine read the same numbers. The EMA is seeded with the simple average of
 * its first `period` values (the TA-Lib and StockCharts convention), which is
 * why its first value sits at index `period - 1`, the same place as the SMA's.
 */

import { assertPeriod, type Series } from "./series.js";

export function sma(values: readonly number[], period: number): Series {
  assertPeriod(period);
  let sum = 0;
  return values.map((value, i) => {
    sum += value;
    if (i >= period)
      sum -= values[i - period]!;
    return i >= period - 1 ? sum / period : null;
  });
}

export function ema(values: readonly number[], period: number): Series {
  const seeds = sma(values, period);
  let previous: number | null = null;
  return values.map((value, i) => {
    if (i < period - 1)
      return null;
    previous = previous === null ? seeds[i]! : value * (2 / (period + 1)) + previous * (1 - 2 / (period + 1));
    return previous;
  });
}
