/**
 * THE CARD SPARKLINE - a hand-written inline `<svg>`, and that is a RULING,
 * not a shortcut.
 *
 * The chart annex settled it against the alternative of a lightweight-charts
 * instance per card: every capability that justifies the SDK (time scale,
 * crosshair, autoscale, primitives, pan and zoom) is switched OFF for a glyph
 * this size, so eight cards would pay four canvases, a ResizeObserver and a
 * RAF loop each to draw "a polyline through N points". The sparkline and the
 * spotlight chart share no invariant, no lifecycle and no failure policy -
 * one is a static derived glyph, the other a live disposable instance - which
 * is the repo's own reuse test coming out NEGATIVE. An `<svg>` has zero
 * teardown surface, scales linearly at near-zero cost, and consumes the
 * design tokens directly. Revisit only if product asks for a crosshair, a
 * tooltip or shared zoom ON THE CARDS.
 *
 * FOUR STATES, and all four DRAW SOMETHING. The card's price row has a fixed
 * geometry, so a sparkline that renders nothing would leave a hole that reads
 * as a layout bug rather than as an absence of data:
 *
 *   pending      bars have been asked for and have not landed - a shimmer at
 *                the line's own height, stilled under reduced motion.
 *   unavailable  no bars will land (nothing was asked, or the ask failed) -
 *                a dim baseline. The element keeps its place and claims
 *                nothing about the price.
 *   flat         every bar carries the same close, or there is exactly one -
 *                a level line at mid-height. NOT an autoscaled full-height
 *                zigzag, which is what a naive min/max mapping draws for a
 *                constant series and is the single most misleading thing a
 *                sparkline can do.
 *   series       the ordinary case.
 *
 * GAPS ARE HOLES, NOT STRAIGHT LINES. A bar the provider had no close for is
 * a break in the series, and joining across it would draw a confident
 * interpolation the data never contained. So a run of nulls SPLITS the line
 * into segments, each with its own polyline, and the gap is simply empty.
 *
 * NO DECIMAL BECOMES A FLOAT ANYWHERE ELSE. Closes arrive as decimal strings
 * and cross into numbers once, through `toDisplayPrice`, the money boundary
 * `boardChartFeed` already owns. The result is a viewBox coordinate and is
 * never shown as a figure.
 *
 * DECORATIVE. `aria-hidden`, with no text alternative of its own: the card's
 * accessible name already carries the price and the 24 hour change, which is
 * everything this glyph encodes. A second reading would say it twice.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { toDisplayPrice } from "./boardChartFeed.js";
import type { BoardTrend } from "./boardFormat.js";

/** One bar of a card sparkline. `c` is null when the provider had no close. */
export interface BoardSparklineBar {
  readonly tMs: number;
  readonly c: string | null;
}

/**
 * What the sparkline pipeline has for this card.
 *
 * A discriminated union rather than `bars: Bar[] | null`, because "not asked
 * yet" and "asked, nothing came" are different facts with different designed
 * states, and a nullable array collapses them.
 */
export type BoardSparklineData =
  | { readonly status: "pending" }
  | { readonly status: "unavailable" }
  | { readonly status: "bars"; readonly bars: readonly BoardSparklineBar[] };

/** The viewBox. Fixed, so the path arithmetic is resolution independent. */
const VIEW_W = 120;
const VIEW_H = 44;
/** Breathing room so the extreme bars are not clipped by the stroke width. */
const PAD_Y = 3;

export interface BoardSparklineProps {
  readonly data: BoardSparklineData;
  /** Colours the line. The card's own 24h delta decides it. */
  readonly trend: BoardTrend;
  readonly className?: string;
}

/** One unbroken run of priced bars, in viewBox coordinates. */
interface Segment {
  readonly points: readonly (readonly [number, number])[];
}

export function BoardSparkline({
  data,
  trend,
  className,
}: BoardSparklineProps): JSX.Element {
  const stroke =
    trend === "down"
      ? "var(--vex-alias-state-error)"
      : trend === "flat"
        ? "var(--vex-alias-label-tertiary)"
        : "var(--vex-alias-state-success)";

  const state = sparklineState(data);

  if (state.kind === "pending") {
    return (
      <span
        data-vex-area="board-sparkline"
        data-state="pending"
        aria-hidden
        className={cn(
          "block h-[44px] w-full rounded-[3px] bg-surface-skeleton",
          // The shimmer is the app's own pending register, and it is stilled
          // outright for a reader who asked for reduced motion - the block is
          // fully legible as a placeholder with no animation at all.
          "animate-pulse motion-reduce:animate-none",
          className,
        )}
      />
    );
  }

  return (
    <svg
      data-vex-area="board-sparkline"
      data-state={state.kind}
      aria-hidden
      focusable={false}
      viewBox={`0 0 ${String(VIEW_W)} ${String(VIEW_H)}`}
      preserveAspectRatio="none"
      className={cn("block h-[44px] w-full", className)}
    >
      {state.kind === "unavailable" ? (
        <line
          data-vex-area="board-sparkline-baseline"
          x1="0"
          y1={VIEW_H / 2}
          x2={VIEW_W}
          y2={VIEW_H / 2}
          stroke="var(--vex-alias-border-l2)"
          strokeWidth="1"
          strokeDasharray="3 3"
        />
      ) : null}
      {state.kind !== "unavailable"
        ? state.segments.map((segment, index) => (
            <SegmentShape
              key={`${String(index)}/${String(segment.points[0]?.[0] ?? 0)}`}
              segment={segment}
              stroke={stroke}
            />
          ))
        : null}
    </svg>
  );
}

/**
 * One run of priced bars: a line, and only a line.
 *
 * No area fill under it (the mockup draws a bare line, and a wash under eight
 * card sparklines is what made the grid read as a chart wall), so there is
 * no gradient and no document-global `<defs>` id to keep collision-free.
 *
 * A single-point run draws a DOT rather than a zero-length polyline, which
 * renders as nothing at all in every browser and would silently delete the
 * one reading the provider did give us.
 */
function SegmentShape({
  segment,
  stroke,
}: {
  readonly segment: Segment;
  readonly stroke: string;
}): JSX.Element | null {
  const points = segment.points;
  const first = points[0];
  if (first === undefined) return null;
  if (points.length === 1) {
    return (
      <circle
        data-vex-area="board-sparkline-point"
        cx={first[0]}
        cy={first[1]}
        r="1.6"
        fill={stroke}
      />
    );
  }
  const line = points.map(([x, y]) => `${fixed(x)},${fixed(y)}`).join(" ");
  return (
    <polyline
      data-vex-area="board-sparkline-line"
      points={line}
      fill="none"
      stroke={stroke}
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

type SparklineState =
  | { readonly kind: "pending" }
  | { readonly kind: "unavailable" }
  | { readonly kind: "flat"; readonly segments: readonly Segment[] }
  | { readonly kind: "series"; readonly segments: readonly Segment[] };

/**
 * Bars to viewBox geometry. PURE and exported for the table test, because
 * every state this component has is decided here rather than in JSX.
 *
 * X is the bar's INDEX, not its timestamp: a card sparkline is a shape, and
 * spacing it by real time would make an hour-long provider outage into a wide
 * empty stretch that reads as a price event. The gap is still honest - it is
 * simply a break in the line rather than a stretched one.
 */
export function sparklineState(data: BoardSparklineData): SparklineState {
  if (data.status === "pending") return { kind: "pending" };
  if (data.status === "unavailable") return { kind: "unavailable" };
  const bars = data.bars;
  if (bars.length === 0) return { kind: "unavailable" };

  const values = bars.map((bar) =>
    bar.c === null ? null : toDisplayPrice(bar.c),
  );
  const priced = values.filter((value): value is number => value !== null);
  if (priced.length === 0) return { kind: "unavailable" };

  let min = priced[0] as number;
  let max = min;
  for (const value of priced) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  // FLAT IS ITS OWN STATE. With min === max the normalisation below divides by
  // zero; mapping to the middle instead is not a guard against NaN, it is the
  // truthful drawing of a series that did not move.
  const flat = max - min === 0;
  const span = VIEW_H - PAD_Y * 2;
  const step = bars.length === 1 ? 0 : VIEW_W / (bars.length - 1);

  const segments: Segment[] = [];
  let current: (readonly [number, number])[] = [];
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length > 0) segments.push({ points: current });
      current = [];
      return;
    }
    const x = bars.length === 1 ? VIEW_W / 2 : step * index;
    const y = flat
      ? VIEW_H / 2
      : VIEW_H - PAD_Y - ((value - min) / (max - min)) * span;
    current.push([x, y]);
  });
  if (current.length > 0) segments.push({ points: current });

  return flat ? { kind: "flat", segments } : { kind: "series", segments };
}

/** Two decimals is well past SVG's useful precision at this size. */
function fixed(value: number): string {
  return (Math.round(value * 100) / 100).toString();
}
