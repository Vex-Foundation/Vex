/**
 * THE WALLET TOTAL CHART'S GEOMETRY (docs/design/H3-DESKTOP.md section 4.1
 * item 12, A.8: H3's EQUITY chart over desktop's balance snapshots, 24 h, 7 d,
 * 30 d and all). Pure: points in, a drawing out, so every rule below is
 * table-testable without a layout engine.
 *
 * WHAT IS DRAWN, AND WHY.
 *   - The points are `vex.portfolio.readHistory`'s, oldest first, each one
 *     complete snapshot cycle on the read's own basis (settled plus in
 *     transit). Nothing is interpolated, smoothed, back-filled or estimated.
 *   - THE LINE JOINS COMPLETE CYCLES ONLY. A `partial: true` cycle is one in
 *     which a chain read failed: its value is real but incomplete, so it is
 *     usually LOW by whatever the failed chain held. Joined into the line it
 *     would draw a dip that never happened in the wallets. So it is drawn as a
 *     hollow mark at its own value, off the line, and the chart says what a
 *     hollow mark means; nothing is dropped. With no complete cycle at all
 *     there is no line, only marks.
 *   - THE TIME AXIS IS THE RANGE, NOT THE DATA. For 24 h, 7 d and 30 d the
 *     axis spans the whole range ending at the newest cycle, so a history that
 *     began three days ago starts three days in from the left rather than
 *     being stretched to look like a month. "All" spans the first cycle to the
 *     newest. Main returns only cycles inside the range (relative to now, and
 *     the newest cycle is at or before now), so every point falls inside.
 *   - THE VALUE AXIS fits the points (complete and partial alike, so a mark is
 *     never off the plot) with round tick values; a flat history gets a band
 *     around its one value instead of a divide by zero.
 *
 * Coordinates are normalized: x and y run 0 to 1 over the plot (y from the
 * top). The SVG path is written for a 1000 x 300 viewBox drawn with
 * `preserveAspectRatio="none"`, so it fills any width; labels and marks are
 * HTML placed by percentage, so they never stretch with it.
 */

import type {
  PortfolioHistoryPointDto,
  PortfolioHistoryRange,
} from "@shared/schemas/portfolio-history.js";

/** The path's viewBox. The SVG stretches to its box; strokes do not scale. */
export const CHART_VIEWBOX = { width: 1000, height: 300 } as const;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** Each fixed range's span; "all" spans its own points. */
const RANGE_SPAN_MS: Readonly<Record<Exclude<PortfolioHistoryRange, "all">, number>> = {
  "24h": DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
};

/** A point placed on the plot. */
export interface PlacedPoint {
  /** 0 at the left edge, 1 at the right. */
  readonly x: number;
  /** 0 at the top, 1 at the bottom. */
  readonly y: number;
  readonly at: number;
  readonly totalUsd: number;
}

export interface AxisTick {
  /** Position along the axis, 0 to 1 (y from the top). */
  readonly at: number;
  readonly label: string;
}

export interface EquityChartModel {
  /** The line's path in viewBox units, or null with fewer than two complete cycles. */
  readonly line: string | null;
  /** The area under the line, closed to the plot's foot, or null with no line. */
  readonly area: string | null;
  /** Complete cycles, placed: the line's vertices (a lone one is drawn as a mark). */
  readonly complete: readonly PlacedPoint[];
  /** Partial cycles, placed: the hollow marks, off the line. */
  readonly partial: readonly PlacedPoint[];
  readonly yTicks: readonly AxisTick[];
  readonly xTicks: readonly AxisTick[];
  /** The time domain, epoch ms. */
  readonly from: number;
  readonly to: number;
}

function finitePoints(points: readonly PortfolioHistoryPointDto[]): {
  readonly at: number;
  readonly totalUsd: number;
  readonly partial: boolean;
}[] {
  const out: { at: number; totalUsd: number; partial: boolean }[] = [];
  for (const point of points) {
    const at = Date.parse(point.at);
    if (!Number.isFinite(at) || !Number.isFinite(point.totalUsd)) continue;
    out.push({ at, totalUsd: point.totalUsd, partial: point.partial });
  }
  return out;
}

/** A round step near `raw`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceStep(raw: number): number {
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const fraction = raw / power;
  const nice = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return nice * power;
}

/** The value axis: round ticks covering [min, max], about three of them. */
export function valueTicks(min: number, max: number): { readonly low: number; readonly high: number; readonly step: number } {
  // A flat history: a band of 1% of its value (or 1 at zero) around it.
  const spread = max - min;
  const pad = spread > 0 ? 0 : Math.max(Math.abs(max) * 0.01, 1);
  const lo = min - pad;
  const hi = max + pad;
  const step = niceStep((hi - lo) / 2);
  const low = Math.floor(lo / step) * step;
  const high = Math.ceil(hi / step) * step;
  return { low, high: high > low ? high : low + step, step };
}

function valueLabel(value: number, step: number): string {
  const digits = step >= 1 ? 0 : step >= 0.1 ? 1 : 2;
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
}

/** The time axis's words: a clock within a day, a date beyond, a month past ten. */
export function timeLabel(ms: number, spanMs: number): string {
  const date = new Date(ms);
  if (spanMs <= 2 * DAY_MS) {
    return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  }
  if (spanMs <= 300 * DAY_MS) {
    return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(date);
}

/** Five evenly spaced time labels across the domain (one when it has no width). */
function timeTicks(from: number, to: number): AxisTick[] {
  const span = to - from;
  if (!(span > 0)) return [{ at: 1, label: timeLabel(to, 0) }];
  const ticks: AxisTick[] = [];
  for (let index = 0; index <= 4; index += 1) {
    ticks.push({ at: index / 4, label: timeLabel(from + (span * index) / 4, span) });
  }
  return ticks;
}

function pathOf(points: readonly PlacedPoint[]): string {
  return points
    .map((point, index) => {
      const x = (point.x * CHART_VIEWBOX.width).toFixed(2);
      const y = (point.y * CHART_VIEWBOX.height).toFixed(2);
      return `${index === 0 ? "M" : "L"}${x} ${y}`;
    })
    .join(" ");
}

/**
 * The drawing for one range. Null when no point is drawable (an empty or an
 * unreadable answer): the caller says why in words instead.
 */
export function equityChartModel(
  points: readonly PortfolioHistoryPointDto[],
  range: PortfolioHistoryRange,
): EquityChartModel | null {
  const usable = finitePoints(points).sort((a, b) => a.at - b.at);
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (first === undefined || last === undefined) return null;

  const to = last.at;
  const from = range === "all" ? first.at : Math.min(first.at, to - RANGE_SPAN_MS[range]);
  const span = to - from;

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const point of usable) {
    min = Math.min(min, point.totalUsd);
    max = Math.max(max, point.totalUsd);
  }
  const axis = valueTicks(min, max);
  const height = axis.high - axis.low;

  const place = (point: { readonly at: number; readonly totalUsd: number }): PlacedPoint => ({
    x: span > 0 ? (point.at - from) / span : 1,
    y: 1 - (point.totalUsd - axis.low) / height,
    at: point.at,
    totalUsd: point.totalUsd,
  });

  const complete = usable.filter((point) => !point.partial).map(place);
  const partial = usable.filter((point) => point.partial).map(place);

  const yTicks: AxisTick[] = [];
  for (let value = axis.high; value >= axis.low - axis.step / 2; value -= axis.step) {
    yTicks.push({ at: 1 - (value - axis.low) / height, label: valueLabel(value, axis.step) });
  }

  let line: string | null = null;
  let area: string | null = null;
  const head = complete[0];
  const tail = complete[complete.length - 1];
  if (complete.length >= 2 && head !== undefined && tail !== undefined) {
    line = pathOf(complete);
    const foot = CHART_VIEWBOX.height.toFixed(2);
    area = `${line} L${(tail.x * CHART_VIEWBOX.width).toFixed(2)} ${foot} L${(head.x * CHART_VIEWBOX.width).toFixed(2)} ${foot} Z`;
  }

  return { line, area, complete, partial, yTicks, xTicks: timeTicks(from, to), from, to };
}
