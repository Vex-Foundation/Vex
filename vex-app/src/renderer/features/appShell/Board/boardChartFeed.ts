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
  SingleValueData,
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
  /**
   * Drawn bars whose reported high/low did not span their own open/close, so
   * the chart derived its extremes from all four values instead. A measured
   * provider fact, not a defensive branch - see `toChartBar`.
   */
  readonly incoherentCount: number;
}

/**
 * THE conversion boundary. A row that cannot yield four finite numbers
 * becomes WHITESPACE - it holds its slot on the time axis and draws nothing.
 * It never becomes a fabricated zero and it is never dropped, because a gap
 * the provider reported is a fact about the market, not an absence of data.
 */
/** A converted bar plus the facts the caller has to REPORT about it. */
interface ConvertedBar {
  readonly bar: BoardChartBar;
  /**
   * True when the provider's own high/low did not span its open/close, so the
   * high and low handed to the library are derived rather than reported.
   */
  readonly incoherent: boolean;
}

function convertBar(row: BoardCandleInput): ConvertedBar {
  const time = Math.floor(row.tMs / 1000) as UTCTimestamp;
  if (!Number.isFinite(row.tMs)) {
    // A non-finite timestamp cannot index anything; surface it as whitespace
    // at time 0 rather than poisoning the axis with NaN.
    return { bar: { time: 0 as UTCTimestamp }, incoherent: false };
  }
  const { o, h, l, c } = row;
  if (o === null || h === null || l === null || c === null) {
    return { bar: { time }, incoherent: false };
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
    return { bar: { time }, incoherent: false };
  }
  // CHART-ONLY EXTREMES.
  //
  // MEASURED provider behavior, not a guard against the impossible: the
  // DexScreener USD OHLC series reports an open or a close OUTSIDE its own
  // high/low on 382 of 999 rows measured (the candles handler records the
  // count). The library autoscales the price axis from `high`/`low` ALONE, so
  // forwarding the reported pair unchanged clips the body of every such
  // candle out of the visible range - the reader sees a bar whose open or
  // close is off the chart and reads the wrong extreme for the period.
  //
  // The four values are all facts the provider reported, so the honest chart
  // geometry is the one that contains all four. The reported high/low are not
  // corrected anywhere else: nothing here is written back, and the divergence
  // is COUNTED so the caveat line can disclose it.
  const drawnHigh = Math.max(open, high, low, close);
  const drawnLow = Math.min(open, high, low, close);
  return {
    bar: { time, open, high: drawnHigh, low: drawnLow, close },
    incoherent: drawnHigh !== high || drawnLow !== low,
  };
}

/**
 * THE conversion boundary. A row that cannot yield four finite numbers
 * becomes WHITESPACE - it holds its slot on the time axis and draws nothing.
 * It never becomes a fabricated zero and it is never dropped, because a gap
 * the provider reported is a fact about the market, not an absence of data.
 *
 * The `high`/`low` of the returned bar span all four reported values; see
 * `convertBar` for the measured reason.
 */
export function toChartBar(row: BoardCandleInput): BoardChartBar {
  return convertBar(row).bar;
}

/**
 * Smallest price movement the axis must be able to distinguish, derived from
 * the series' OWN decimal precision.
 *
 * WHY IT CANNOT BE 0. The library computes `base = 1 / minMove`, so a
 * `minMove` of 0 makes the base `Infinity` and `priceScale.minMove()` collapse
 * back to `1 / Infinity = 0`. The one place that value is load-bearing is the
 * degenerate-range branch of autoscaling: a series whose min equals its max is
 * extended by `5 * minMove` to avoid "incorrect range and empty (blank)
 * scale", and with 0 that extension is 0 - so a FLAT series (an illiquid pool
 * that did not move all window) renders as a blank scale. Verified against the
 * installed 5.2.1 bundle.
 *
 * WHY IT IS DERIVED RATHER THAN FIXED. A board price is a decimal string that
 * may be 1e-13; a fixed 0.01 would make every tick on such a series identical.
 * The strings carry their own precision, so the tick is the last place value
 * the series actually uses, bounded at {@link CHART_MIN_MOVE_MAX_DECIMALS}
 * (past ~15 significant digits a double cannot represent the difference
 * anyway). Display geometry only: no figure a user acts on is derived here.
 */
export const CHART_MIN_MOVE_MAX_DECIMALS = 15;

/**
 * Decimal places this series actually uses: the longest fractional part any
 * of its decimal strings carries, bounded at
 * {@link CHART_MIN_MOVE_MAX_DECIMALS}.
 *
 * It is the SINGLE precision fact about a series, and both consumers derive
 * from it rather than computing their own: {@link chartMinMove} turns it into
 * the library's tick, and {@link createChartAxisPriceFormatter} uses it as the
 * hard ceiling on how many places an axis label may print. A second
 * derivation would be a second source of truth, and the axis defect this
 * bounds is exactly what happens when the label is allowed to outrun the tick.
 */
export function chartPriceDecimals(rows: readonly BoardCandleInput[]): number {
  let decimals = 0;
  for (const row of rows) {
    for (const leg of [row.o, row.h, row.l, row.c]) {
      if (leg === null) continue;
      const dot = leg.indexOf(".");
      if (dot < 0) continue;
      const used = leg.length - dot - 1;
      if (used > decimals) decimals = used;
    }
  }
  return decimals > CHART_MIN_MOVE_MAX_DECIMALS
    ? CHART_MIN_MOVE_MAX_DECIMALS
    : decimals;
}

/**
 * The library tick for a given decimal precision. `Number("1e-13")` rather
 * than `10 ** -13`: the exponent literal is exact to the nearest double, the
 * repeated multiplication is not.
 */
export function minMoveForDecimals(decimals: number): number {
  return Number(`1e-${decimals}`);
}

export function chartMinMove(rows: readonly BoardCandleInput[]): number {
  return minMoveForDecimals(chartPriceDecimals(rows));
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
  const incoherentTimes = new Set<number>();
  for (const row of rows) {
    const { bar, incoherent } = convertBar(row);
    const time = bar.time as number;
    byTime.set(time, bar);
    // LAST value wins for the bar, so the verdict follows it: a re-emitted
    // forming bar that arrives coherent clears the flag its earlier copy set.
    if (incoherent) incoherentTimes.add(time);
    else incoherentTimes.delete(time);
  }
  const ordered = [...byTime.values()].sort(
    (a, b) => (a.time as number) - (b.time as number),
  );
  const totalDistinct = ordered.length;
  const hiddenOlder = Math.max(0, totalDistinct - BOARD_CHART_MAX_BARS);
  const bars = hiddenOlder === 0 ? ordered : ordered.slice(hiddenOlder);
  let whitespaceCount = 0;
  let incoherentCount = 0;
  for (const bar of bars) {
    if (!isDrawnBar(bar)) whitespaceCount += 1;
    else if (incoherentTimes.has(bar.time as number)) incoherentCount += 1;
  }
  return { bars, totalDistinct, hiddenOlder, whitespaceCount, incoherentCount };
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
 * Build the price-axis label formatter for a `PriceFormatCustom`, bounded by
 * the decimal precision the SERIES itself uses ({@link chartPriceDecimals}).
 *
 * WHY IT IS BOUND TO THE SERIES, and it is a production defect, not a
 * refinement. The library's tick loop walks the visible range by repeated
 * subtraction of the span, and the default `rightPriceScale.scaleMargins`
 * extrapolate that range BELOW zero whenever the series' max exceeds roughly
 * 7.96x its min at our chart height. The bottom tick therefore lands on
 * floating-point residue near zero rather than on zero. Measured family:
 * min 0.00100, max 0.02362 at 256px yields a tick of
 * -5.204170427930421e-18. A formatter that expands by MAGNITUDE alone renders
 * that residue as `-0.000000000000000005`, an eighteen-decimal negative price
 * on a series whose own strings carry five. The scale margins are a
 * deliberate design choice and are unchanged; the label is what was lying.
 *
 * So the ceiling is the series' own precision: a tick finer than any price
 * the series expresses cannot say anything true, and every value inside that
 * residue band collapses to the honest `0`. The `-0.000...` and `0.000...`
 * forms are normalized to `0` for the same reason - a negative sign on a
 * value the series cannot distinguish from zero is noise presented as a fact.
 *
 * The magnitude ladder below still matters at the other end: the built-in
 * `{ precision: 2, minMove: 0.01 }` default renders a 1e-13 memecoin price as
 * `0.00` on every tick, which makes the whole chart read as blank. The
 * library's value guard bounds MAGNITUDE (roughly +/-9.007e13) and imposes no
 * lower bound, so tiny prices are accepted and only the formatting has to be
 * right.
 *
 * Axis labels only - never a figure a user acts on financially.
 */
export function createChartAxisPriceFormatter(
  maxDecimals: number,
): (value: number) => string {
  const ceiling = Math.max(
    0,
    Math.min(CHART_MIN_MOVE_MAX_DECIMALS, Math.floor(maxDecimals)),
  );
  return (value: number): string => {
    if (!Number.isFinite(value)) return "";
    const abs = Math.abs(value);
    let decimals: number;
    if (abs >= 1) decimals = 2;
    else if (abs >= 0.01) decimals = 4;
    else if (abs === 0) decimals = 0;
    else decimals = Math.ceil(-Math.log10(abs)) + 3;
    const text = value.toFixed(Math.min(decimals, ceiling));
    // `-0`, `-0.00000` and `0.0000` all mean "below anything this series can
    // express". One honest zero, never a signed one.
    return /^-?0(?:\.0*)?$/.test(text) ? "0" : text;
  };
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
/**
 * The exact series surface the feed drives. Narrow on purpose: the test fake
 * implements it directly and the library's `ISeriesApi<"Candlestick">`
 * satisfies it structurally, so no unsafe cast sits between a fake and this
 * contract.
 */
export interface BoardCandleSink {
  setData(data: CandlestickData<Time>[]): void;
  update(bar: CandlestickData<Time>): void;
}

export class CandleFeed {
  private lastTimeSec: number | null = null;

  constructor(private readonly series: BoardCandleSink) {}

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

/* ------------------------------------------------------------------ */
/* AREA SERIES - the spotlight's line, derived from the same OHLC      */
/* ------------------------------------------------------------------ */

/**
 * One point of the spotlight's area series, or a whitespace slot.
 *
 * The domain truth stays OHLC and the area DERIVES `value = close`
 * (SPOTLIGHT-CHART-CONTRACT 1.3). Deriving at the chart boundary costs one
 * field read; discarding the other three legs at the adapter would be
 * irreversible, and a candle view later would have nothing to draw.
 */
export type BoardChartAreaPoint =
  | SingleValueData<UTCTimestamp>
  | WhitespaceData<UTCTimestamp>;

/**
 * A board candle as one area point.
 *
 * Same boundary rules as {@link toChartBar}: ONE `Math.floor(ms / 1000)`, a
 * decimal string becoming a DISPLAY float and nothing else, and a null or
 * non-finite close becoming WHITESPACE rather than a fabricated zero. The
 * `drawnHigh/drawnLow` repair that `toChartBar` performs is a CANDLE concern
 * and deliberately absent here: the close is the close, and no reported
 * extreme is being drawn for a reader to be misled by.
 */
export function toChartAreaPoint(row: BoardCandleInput): BoardChartAreaPoint {
  const time = Math.floor(row.tMs / 1000) as UTCTimestamp;
  const close = row.c === null ? null : toDisplayPrice(row.c);
  if (close === null) return { time };
  return { time, value: close };
}

/** A normalized area series, with every bound it applied reported. */
export interface NormalizedBoardArea {
  readonly points: readonly BoardChartAreaPoint[];
  readonly totalDistinct: number;
  /** Older points the display budget kept off the chart. Never silent. */
  readonly hiddenOlder: number;
  readonly whitespaceCount: number;
  readonly oldestTimeSec: number | null;
  readonly newestTimeSec: number | null;
}

/**
 * Sort, dedupe and convert a page of provider bars into an area series.
 *
 * Dedupe is last-write-wins on the floored second, exactly as
 * {@link normalizeBoardBars}: the forming bar is re-emitted by design on
 * every poll, so a duplicate is the normal case rather than a provider fault.
 */
export function normalizeBoardAreaPoints(
  rows: readonly BoardCandleInput[],
): NormalizedBoardArea {
  const byTime = new Map<number, BoardChartAreaPoint>();
  for (const row of rows) {
    const point = toChartAreaPoint(row);
    byTime.set(point.time as number, point);
  }
  const ordered = [...byTime.values()].sort(
    (a, b) => (a.time as number) - (b.time as number),
  );
  const totalDistinct = ordered.length;
  const hiddenOlder = Math.max(0, totalDistinct - BOARD_CHART_MAX_BARS);
  const points = hiddenOlder === 0 ? ordered : ordered.slice(hiddenOlder);
  let whitespaceCount = 0;
  for (const point of points) {
    if (!("value" in point)) whitespaceCount += 1;
  }
  return {
    points,
    totalDistinct,
    hiddenOlder,
    whitespaceCount,
    oldestTimeSec: (points[0]?.time as number | undefined) ?? null,
    newestTimeSec: (points.at(-1)?.time as number | undefined) ?? null,
  };
}

/** What one area point carries, for a set-based comparison. */
type AreaValue = number | null;

function areaValueOf(point: BoardChartAreaPoint): AreaValue {
  return "value" in point ? point.value : null;
}

/**
 * What the chart must DO with a poll response, decided as a pure function.
 *
 * WHY THIS IS A FUNCTION AND NOT A BRANCH INSIDE AN EFFECT. Every row of the
 * chart contract's reconciliation table is a claim about this decision, and a
 * claim that lives inside a `useEffect` beside a canvas can only be tested by
 * driving a canvas. Here the whole table is a table test.
 *
 * THE COMPARISON IS OVER TIMESTAMP SETS, not lengths (A8). A rolling window
 * that replaced a constant number of bars would look right to a reader at the
 * live edge and silently move a reader scrolled back into history; asking
 * which exact timestamps left, arrived, or changed value is the only form of
 * the question that is answerable for both.
 */
export type AreaReconciliation =
  | {
      readonly kind: "reset";
      readonly reason:
        | "seed"
        | "left-trim"
        | "interior-change"
        | "shrink"
        | "many-corrections";
      readonly points: readonly BoardChartAreaPoint[];
    }
  | {
      readonly kind: "incremental";
      /** Past points whose value changed. Applied with `historicalUpdate`. */
      readonly corrections: readonly BoardChartAreaPoint[];
      /** The forming bar and any newly closed ones, oldest first. */
      readonly appends: readonly BoardChartAreaPoint[];
    }
  | { readonly kind: "keep"; readonly reason: "empty-response" };

/**
 * Above this many corrected past points, a full `setData` is cheaper than N
 * `historicalUpdate` calls, which the library documents as the slower path.
 * Both are viewport-neutral, so the choice is pure cost (contract 2.2 row 6b).
 */
export const AREA_MAX_HISTORICAL_UPDATES = 3;

export function reconcileAreaSeries(
  held: readonly BoardChartAreaPoint[],
  incoming: readonly BoardChartAreaPoint[],
): AreaReconciliation {
  if (incoming.length === 0) return { kind: "keep", reason: "empty-response" };
  if (held.length === 0) return { kind: "reset", reason: "seed", points: incoming };

  const incomingByTime = new Map<number, BoardChartAreaPoint>();
  for (const point of incoming) incomingByTime.set(point.time as number, point);
  const incomingOldest = incoming[0]?.time as number;

  // A held point the response no longer carries is either the window sliding
  // (it is older than everything in the response) or a genuine interior
  // disappearance. The first is expected and the second must not be papered
  // over by an append, so both take the full-replace path and the caller
  // states the trim in words.
  let trimmed = false;
  for (const point of held) {
    const time = point.time as number;
    if (incomingByTime.has(time)) continue;
    if (time < incomingOldest) {
      trimmed = true;
      continue;
    }
    return { kind: "reset", reason: "interior-change", points: incoming };
  }
  if (trimmed) return { kind: "reset", reason: "left-trim", points: incoming };

  const newestHeld = held.at(-1)?.time as number;
  const corrections: BoardChartAreaPoint[] = [];
  const appends: BoardChartAreaPoint[] = [];
  for (const point of incoming) {
    const time = point.time as number;
    // The bar AT the newest held time is the FORMING bar: its value is
    // supposed to change, and it is an update rather than a correction.
    if (time >= newestHeld) {
      appends.push(point);
      continue;
    }
    const heldPoint = held.find((candidate) => (candidate.time as number) === time);
    if (heldPoint === undefined) {
      // Older than the newest held point and not held: the response reaches
      // further back than the chart does. That is a new window, not an append.
      return { kind: "reset", reason: "shrink", points: incoming };
    }
    if (areaValueOf(heldPoint) !== areaValueOf(point)) corrections.push(point);
  }
  if (corrections.length > AREA_MAX_HISTORICAL_UPDATES) {
    return { kind: "reset", reason: "many-corrections", points: incoming };
  }
  return { kind: "incremental", corrections, appends };
}

/** The sink an {@link AreaFeed} writes through. */
export interface BoardAreaSink {
  setData(data: BoardChartAreaPoint[]): void;
  update(point: BoardChartAreaPoint, historicalUpdate?: boolean): void;
}

/**
 * The spotlight's series writer, and the ONE place `setData` / `update` are
 * called on the area series.
 *
 * It holds the points it wrote so reconciliation can compare timestamp SETS
 * without a `series.data()` scan per poll, and so `oldestTimeSec` and the
 * held count are answerable - the two facts the contract's trim condition
 * needs and `CandleFeed` never had to provide.
 */
export class AreaFeed {
  private points: readonly BoardChartAreaPoint[] = [];

  constructor(private readonly series: BoardAreaSink) {}

  get held(): readonly BoardChartAreaPoint[] {
    return this.points;
  }

  get heldCount(): number {
    return this.points.length;
  }

  get oldestTimeSec(): number | null {
    return (this.points[0]?.time as number | undefined) ?? null;
  }

  get newestTimeSec(): number | null {
    return (this.points.at(-1)?.time as number | undefined) ?? null;
  }

  reset(points: readonly BoardChartAreaPoint[]): void {
    this.series.setData([...points]);
    this.points = points;
  }

  /**
   * Apply a reconciliation. Returns what was actually written, so a caller
   * can report it rather than assume it.
   */
  apply(plan: AreaReconciliation): {
    readonly reset: boolean;
    readonly corrected: number;
    readonly appended: number;
  } {
    if (plan.kind === "keep") return { reset: false, corrected: 0, appended: 0 };
    if (plan.kind === "reset") {
      this.reset(plan.points);
      return { reset: true, corrected: 0, appended: 0 };
    }
    for (const point of plan.corrections) {
      // `historicalUpdate` throws when the time does not already exist, which
      // is exactly why the plan only ever names times the feed holds.
      this.series.update(point, true);
    }
    let appended = 0;
    const merged = new Map<number, BoardChartAreaPoint>();
    for (const point of this.points) merged.set(point.time as number, point);
    for (const point of plan.corrections) merged.set(point.time as number, point);
    for (const point of plan.appends) {
      this.series.update(point);
      merged.set(point.time as number, point);
      appended += 1;
    }
    this.points = [...merged.values()].sort(
      (a, b) => (a.time as number) - (b.time as number),
    );
    return { reset: false, corrected: plan.corrections.length, appended };
  }
}
