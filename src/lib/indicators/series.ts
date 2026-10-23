/**
 * The series contract every indicator in this module keeps.
 *
 * An output series is aligned index for index with its input: entry `i`
 * belongs to input bar `i`, and an entry is `null` while the indicator is
 * still warming up. Nothing is ever dropped from the front, so a caller can
 * zip any two series with the bars they came from without bookkeeping.
 *
 * Pure by construction: no imports, no clock, no I/O. The engine and the
 * renderer both import this module, so it must stay that way.
 */

export type Series = (number | null)[];

/** One bar's prices as the range-based indicators read them. */
export interface PriceBar {
  readonly high: number;
  readonly low: number;
  readonly close: number;
}

/** A look-back must be a whole number of bars, at least one. */
export function assertPeriod(period: number): void {
  if (!Number.isInteger(period) || period < 1)
    throw new RangeError("Invalid period");
}

/** The newest value of a series, or `null` when it is empty or still warming up. */
export function lastValue(series: readonly (number | null)[]): number | null {
  return series.length === 0 ? null : series[series.length - 1] ?? null;
}
