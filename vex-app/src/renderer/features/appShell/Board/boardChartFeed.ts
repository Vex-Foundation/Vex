/**
 * BOARD CHART ADAPTER - the only place a board's decimal-string candle
 * becomes a float, and the only writer of a lightweight-charts series.
 *
 * WHY THIS FILE EXISTS AT ALL. The validation lightweight-charts performs in
 * development is stripped from the production bundle: `checkItemsAreOrdered`
 * ("data must be asc ordered by time") and `checkSeriesValuesType` are
 * `assert()` calls behind a build-time constant and are ABSENT from
 * `dist/lightweight-charts.production.mjs` (measured: `grep -c` = 0 on the
 * installed 5.2.1). Unsorted bars, duplicate timestamps, NaN or a stray
 * string therefore throw loudly in dev and corrupt the chart silently in the
 * app we ship. So the adapter owns validation, in a code path identical in
 * dev and prod. Only ONE library check survives minification: the
 * `Cannot update oldest data, last time=..., new time=...` throw in the data
 * layer (`grep -c` = 1), which `CandleFeed.push` exists to never trigger.
 *
 * MONEY-PATH BOUNDARY (rule 90). The board's prices are DECIMAL STRINGS and
 * they stay decimal strings everywhere a human reads a figure. `toChartBar`
 * is the single conversion to `number`, and the number it produces is a
 * DISPLAY coordinate only: no figure a user acts on is ever read back out of
 * `series.data()`. IEEE-754 loses digits past ~15-17 significant figures and
 * that loss is permanent, which is precisely why it is confined here.
 *
 * TIME UNITS. `UTCTimestamp` is a branded number in SECONDS; the board's
 * hydration carries epoch MILLISECONDS. The brand is erased at runtime, so
 * feeding ms where seconds are expected throws nothing and silently plots the
 * year ~58000. The `Math.floor(ms / 1000)` in `toChartBar` is the one and
 * only conversion; no other module in this feature divides by 1000.
 *
 * Types only from `lightweight-charts` here - the import is erased at
 * compile time, so this module carries no runtime dependency on the library
 * and its tests need no canvas.
 */

import { BOARD_MAX_CANDLES } from "@vex-lib/board/index.js";
import type {
  CandlestickData,
  ISeriesApi,
  Time,
  UTCTimestamp,
  WhitespaceData,
} from "lightweight-charts";

/**
 * One bar exactly as board hydration carries it: epoch MILLISECONDS and
 * decimal STRINGS. A null leg means the provider had no value for that leg;
 * it is a gap, never a zero.
 */
export interface BoardCandleInput {
  readonly tMs: number;
  readonly o: string | null;
  readonly h: string | null;
  readonly l: string | null;
  readonly c: string | null;
}

/** A candle the chart can draw, or a whitespace slot that reserves its time. */
export type BoardChartBar =
  | CandlestickData<UTCTimestamp>
  | WhitespaceData<UTCTimestamp>;

/**
 * Display budget for one board chart, in bars. It IS the contract's hydration
 * cap, imported rather than restated: a second literal here would be a second
 * source of truth that drifts the first time the contract's cap moves. A
 * well-formed spec therefore never exceeds it, and the over-budget branch
 * below only fires on a spec that outran its own bound.
 */
export const BOARD_CHART_MAX_BARS = BOARD_MAX_CANDLES;

/**
 * The result of normalizing a board's bars. Nothing is silently dropped: a
 * bound that bites is REPORTED (`hiddenOlder`) so the surface can say how
 * many bars exist beyond what is drawn, per the truncation decree.
 */
export interface NormalizedBoardBars {
  /** Strictly ascending by time, deduplicated, at most `BOARD_CHART_MAX_BARS`. */
  readonly bars: readonly BoardChartBar[];
  /** Distinct timestamps the spec carried, before the display budget applied. */
  readonly totalDistinct: number;
  /** Older bars the budget kept off the chart. 0 when everything is drawn. */
  readonly hiddenOlder: number;
  /** Rows that could not yield four finite prices and became whitespace. */
  readonly whitespaceCount: number;
}

/**
 * THE conversion boundary. A row that cannot yield four finite numbers
 * becomes WHITESPACE - it holds its slot on the time axis and draws nothing.
 * It never becomes a fabricated zero and it is never dropped, because a gap
 * the provider reported is a fact about the market, not an absence of data.
 */
export function toChartBar(row: BoardCandleInput): BoardChartBar {
  const time = Math.floor(row.tMs / 1000) as UTCTimestamp;
  if (!Number.isFinite(row.tMs)) {
    // A non-finite timestamp cannot index anything; surface it as whitespace
    // at time 0 rather than poisoning the axis with NaN.
    return { time: 0 as UTCTimestamp };
  }
  const { o, h, l, c } = row;
  if (o === null || h === null || l === null || c === null) {
    return { time };
  }
  const open = Number(o);
  const high = Number(h);
  const low = Number(l);
  const close = Number(c);
  if (
    !Number.isFinite(open) ||
    !Number.isFinite(high) ||
    !Number.isFinite(low) ||
    !Number.isFinite(close)
  ) {
    return { time };
  }
  return { time, open, high, low, close };
}

/** True when a bar carries real prices rather than reserving a slot. */
function isDrawnBar(
  bar: BoardChartBar,
): bar is CandlestickData<UTCTimestamp> {
  return (bar as CandlestickData<UTCTimestamp>).open !== undefined;
}

/**
 * Sort ascending, dedupe by timestamp (LAST value wins), convert, and apply
 * the display budget to the OLD end so the newest market action is always the
 * part that survives.
 *
 * Dedupe is mandatory, not defensive: the producing handler re-emits the
 * forming bar with new values under the same timestamp whenever
 * `lastBarPartial` is set, and a paging seam can repeat a bar. `setData`
 * requires STRICTLY ascending times and the check that would have caught a
 * duplicate is stripped in production.
 */
export function normalizeBoardBars(
  rows: readonly BoardCandleInput[],
): NormalizedBoardBars {
  const byTime = new Map<number, BoardChartBar>();
  for (const row of rows) {
    const bar = toChartBar(row);
    byTime.set(bar.time as number, bar);
  }
  const ordered = [...byTime.values()].sort(
    (a, b) => (a.time as number) - (b.time as number),
  );
  const totalDistinct = ordered.length;
  const hiddenOlder = Math.max(0, totalDistinct - BOARD_CHART_MAX_BARS);
  const bars = hiddenOlder === 0 ? ordered : ordered.slice(hiddenOlder);
  let whitespaceCount = 0;
  for (const bar of bars) {
    if (!isDrawnBar(bar)) whitespaceCount += 1;
  }
  return { bars, totalDistinct, hiddenOlder, whitespaceCount };
}

/**
 * The sanctioned conversion for an ANNOTATION price - the agent's decimal
 * string becoming a chart coordinate. Same contract as `toChartBar`: the
 * result is a display coordinate, never a money value. A string that is not a
 * finite decimal yields null and the annotation is simply not drawn (its
 * label and its raw price still appear in the React legend, so the reader
 * loses nothing).
 */
export function toDisplayPrice(decimal: string): number | null {
  const trimmed = decimal.trim();
  if (trimmed === "" || !/^-?\d+(?:\.\d+)?$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

/**
 * The sanctioned conversion for an ANNOTATION instant: epoch ms to the
 * chart's SECONDS. The one other place `/ 1000` may appear in this feature,
 * and for the same reason as in `toChartBar`.
 */
export function toDisplayTimeSec(atMs: number): UTCTimestamp | null {
  if (!Number.isFinite(atMs)) return null;
  return Math.floor(atMs / 1000) as UTCTimestamp;
}

/**
 * Price-axis label formatter for a `PriceFormatCustom`.
 *
 * The built-in `{ type: 'price', precision: 2, minMove: 0.01 }` default
 * renders a 1e-13 memecoin price as `0.00` on every axis tick, which makes
 * the whole chart read as blank. The library's value guard bounds MAGNITUDE
 * (roughly +/-9.007e13) and imposes no lower bound, so tiny prices are
 * accepted and only the formatting has to be right.
 *
 * Axis labels only - never a figure a user acts on financially.
 */
export function formatChartAxisPrice(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs >= 1) return value.toFixed(2);
  if (abs >= 0.01) return value.toFixed(4);
  const decimals = Math.min(18, Math.ceil(-Math.log10(abs)) + 3);
  return value.toFixed(decimals);
}

/** What `CandleFeed.push` did with a bar, so callers can assert on it. */
export type CandlePushOutcome = "updated" | "appended" | "stale";

/**
 * Owns one series' data and is its ONLY writer.
 *
 * The series holds no readable "last time" we can trust across a reset, so
 * the feed tracks it and decides `setData` vs `update` from real state rather
 * than calling `update` hopefully. An `update()` whose time is older than the
 * newest held bar is a genuine production throw inside the library; this
 * class returns `'stale'` instead, which is also rule 05's stale-completion
 * guard - a late response loses to the newer state already published.
 */
export class CandleFeed {
  private lastTimeSec: number | null = null;

  constructor(private readonly series: ISeriesApi<"Candlestick", Time>) {}

  /** The newest time held, in SECONDS, or null when the feed is empty. */
  get newestTimeSec(): number | null {
    return this.lastTimeSec;
  }

  /**
   * Full replace, for a subject change (different pool, different
   * resolution) or a prepend. Does NOT touch the viewport: `setData`
   * preserves `barSpacing` and `rightOffset`, and restoring or resetting the
   * visible range is the caller's deliberate decision, never a side effect of
   * data arriving.
   */
  reset(bars: readonly BoardChartBar[]): void {
    this.series.setData(bars as CandlestickData<Time>[]);
    const newest = bars.at(-1);
    this.lastTimeSec = newest === undefined ? null : (newest.time as number);
  }

  /**
   * Incremental write for one bar. Same time replaces the forming bar in
   * place and does not touch the time scale at all; a newer time appends and
   * lets `shiftVisibleRangeOnNewBar` govern whether the view follows.
   */
  push(bar: BoardChartBar): CandlePushOutcome {
    const time = bar.time as number;
    if (this.lastTimeSec !== null && time < this.lastTimeSec) return "stale";
    const outcome: CandlePushOutcome =
      this.lastTimeSec === time ? "updated" : "appended";
    this.series.update(bar as CandlestickData<Time>);
    this.lastTimeSec = time;
    return outcome;
  }
}

/**
 * Identity of what a chart is currently showing. When this string changes the
 * chart is looking at a DIFFERENT subject, which is the one situation where a
 * deliberate viewport reset (`fitContent`) is correct. When it is unchanged,
 * new bars are an incremental write and the viewport is the user's.
 */
export function boardChartSubjectKey(
  chain: string,
  pairAddress: string,
  resolution: string,
): string {
  return `${chain}/${pairAddress}/${resolution}`;
}

/**
 * Bars of `next` strictly newer than `sinceSec`, in ascending order - the
 * tail a same-subject refresh should `push`. The bar AT `sinceSec` is
 * included because it is the forming bar and its values legitimately change.
 */
export function barsToPush(
  next: readonly BoardChartBar[],
  sinceSec: number | null,
): readonly BoardChartBar[] {
  if (sinceSec === null) return next;
  return next.filter((bar) => (bar.time as number) >= sinceSec);
}
