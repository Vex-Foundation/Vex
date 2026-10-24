/**
 * The technical analysis card's chart: closed candles with EMA 20 and EMA 50.
 *
 * Lifecycle copied from `Board/BoardChart.tsx`: the lightweight-charts
 * instance is imperative and DOM-owning, so it lives in a ref, is created once
 * per subject inside an effect, and is released by `chart.remove()` in that
 * effect's cleanup (which is also what makes StrictMode's double effect safe).
 * Colours come from the semantic aliases through the board's palette bridge
 * and are re-read when the theme flips, so there is no second palette.
 *
 * VIEWPORT: the read carries every closed bar loaded, warm-up included, but
 * the card's numbers describe only the newest `windowBars`. The chart frames
 * exactly that window, never `fitContent()`, so what is on screen is what the
 * numbers cover. The card settles its width after the data lands, and the
 * library keeps its bar spacing across a resize, so the frame is re-applied on
 * every resize until the reader moves the chart, and never after.
 *
 * HISTORY: the left edge is fixed to the oldest candle held, so the chart never
 * scrolls into empty time. Panning near that edge asks `loadOlder` for the
 * closed candles before it and prepends them, shifting the viewport by the
 * same count so nothing on screen jumps. An empty answer means the venue has
 * no older history and loading stops; a failed one leaves the edge where it is
 * and tries again on the next pan.
 *
 * THE WHEEL IS SHARED WITH THE TRANSCRIPT. The card sits in a scrolling chat.
 * A vertical wheel scrolls the chat, never the chart. A horizontal wheel (a
 * sideways trackpad swipe, or Shift and the wheel) pans the chart, and a
 * trackpad pinch (which arrives as a wheel with Ctrl held) zooms it. Dragging
 * pans as well.
 *
 * The EMA lines are computed HERE with `@vex-lib/indicators`, the same module
 * the engine reads, over every candle held, so they are warm across the whole
 * framed window. Labels are never drawn by the library; the legend under the
 * canvas names the lines in words.
 */

import { useEffect, useRef, type JSX } from "react";
import {
  CandlestickSeries,
  LineSeries,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LogicalRange,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { ema } from "@vex-lib/indicators/index.js";
import type { TechnicalAnalysisCandle } from "@shared/schemas/technical-analysis.js";
import { ChartAttribution } from "../Board/BoardChart.js";
import { prefersReducedMotion, readBoardChartPalette } from "../Board/boardChartTheme.js";

/**
 * The closed candles before `beforeMs`, oldest first. An empty array means the
 * venue holds nothing older; `null` means the read failed and may be retried.
 */
export type LoadOlderCandles = (beforeMs: number) => Promise<readonly TechnicalAnalysisCandle[] | null>;

export interface TechnicalAnalysisChartProps {
  /** Identity of what is drawn. A change means a new chart and a new fit. */
  readonly subjectKey: string;
  readonly candles: readonly TechnicalAnalysisCandle[];
  /** Closed bars the card's numbers cover: the newest this many are framed. */
  readonly windowBars: number;
  /** Older history for the left edge. Absent means the chart holds only `candles`. */
  readonly loadOlder?: LoadOlderCandles;
  /** Accessible name for the chart figure. */
  readonly label: string;
}

/** Bars from the left edge at which older history is asked for. */
const LOAD_OLDER_WITHIN_BARS = 10;
/** The narrowest and widest zoom a pinch can reach, in bars. */
const PINCH_MIN_BARS = 10;
const PINCH_MAX_BARS = 1_000;

/**
 * The logical range that frames the newest `windowBars` of `count` bars, with
 * one empty slot on the right so the last candle does not touch the axis.
 */
export function analysisWindowRange(count: number, windowBars: number): { from: number; to: number } {
  const shown = Math.max(1, Math.min(count, Math.floor(windowBars)));
  return { from: count - shown - 0.5, to: count + 0.5 };
}

/**
 * Older candles in front of the held series: only bars strictly older than the
 * oldest held, de-duplicated, oldest first. Returns the merged series and how
 * many bars were added, which is the shift the viewport needs.
 */
export function prependOlder(
  held: readonly TechnicalAnalysisCandle[],
  older: readonly TechnicalAnalysisCandle[],
): { readonly merged: readonly TechnicalAnalysisCandle[]; readonly added: number } {
  const oldest = held[0]?.t ?? Number.POSITIVE_INFINITY;
  const seen = new Set<number>();
  const fresh = older
    .filter((candle) => candle.t < oldest && !seen.has(candle.t) && seen.add(candle.t))
    .sort((a, b) => a.t - b.t);
  return { merged: fresh.length === 0 ? held : [...fresh, ...held], added: fresh.length };
}

/** The range a pinch of `deltaY` leaves, scaled about the logical point under the pointer. */
export function pinchRange(range: { from: number; to: number }, anchor: number, deltaY: number): { from: number; to: number } {
  const span = range.to - range.from;
  const factor = Math.exp(deltaY * 0.01);
  const next = Math.min(PINCH_MAX_BARS, Math.max(PINCH_MIN_BARS, span * factor));
  const scale = next / span;
  return { from: anchor - (anchor - range.from) * scale, to: anchor + (range.to - anchor) * scale };
}

/** Places after the point that keep about four significant digits on the axis. */
export function axisPrecision(price: number): number {
  if (!Number.isFinite(price) || price <= 0) return 2;
  const magnitude = Math.floor(Math.log10(price));
  return Math.min(10, Math.max(2, 3 - magnitude));
}

function toTime(ms: number): UTCTimestamp {
  return Math.floor(ms / 1_000) as UTCTimestamp;
}

function lineData(candles: readonly TechnicalAnalysisCandle[], period: number) {
  const series = ema(candles.map((candle) => candle.c), period);
  return candles.flatMap((candle, i) => {
    const value = series[i];
    return value === null || value === undefined || !Number.isFinite(value)
      ? []
      : [{ time: toTime(candle.t), value }];
  });
}

export function TechnicalAnalysisChart({
  subjectKey,
  candles,
  windowBars,
  loadOlder,
  label,
}: TechnicalAnalysisChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const fastRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const slowRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  /** The frame the data effect last chose; the resize observer re-applies it. */
  const frameRef = useRef<{ from: number; to: number } | null>(null);
  /** Set by the reader's first drag, pan or pinch: from then on the viewport is theirs. */
  const readerMovedRef = useRef(false);
  /** Every candle drawn, the read's plus any older history prepended. */
  const heldRef = useRef<readonly TechnicalAnalysisCandle[]>([]);
  const loadingOlderRef = useRef(false);
  const historyEndRef = useRef(false);
  const loadOlderRef = useRef(loadOlder);
  loadOlderRef.current = loadOlder;
  const precision = axisPrecision(candles[candles.length - 1]?.c ?? 0);

  // ── The instance. One per subject and precision - nothing else. ─────────
  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const palette = readBoardChartPalette(container);
    const reduced = prefersReducedMotion();
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        // Attribution is owned text below the canvas, not the library's link.
        attributionLogo: false,
        background: { color: "transparent" },
        textColor: palette.ink,
        fontSize: 11,
      },
      grid: { vertLines: { color: palette.grid }, horzLines: { color: palette.grid } },
      rightPriceScale: { borderColor: palette.grid },
      timeScale: { borderColor: palette.grid, timeVisible: true, fixLeftEdge: true },
      kineticScroll: { touch: !reduced, mouse: false },
      // The library pans on a horizontal wheel only; its vertical-wheel zoom
      // would take the chat's scroll, so the pinch is handled below instead.
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false },
    });
    const priceFormat = { type: "price" as const, precision, minMove: 10 ** -precision };
    const candlesSeries = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.up,
      borderDownColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      priceFormat,
    });
    const lineOptions = { lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, priceFormat };
    const fast = chart.addSeries(LineSeries, { ...lineOptions, color: palette.accent });
    const slow = chart.addSeries(LineSeries, { ...lineOptions, color: palette.ink });
    chartRef.current = chart;
    candleRef.current = candlesSeries;
    fastRef.current = fast;
    slowRef.current = slow;

    // Theme repointing without a rebuild, as the board chart does.
    const themeObserver = new MutationObserver(() => {
      const next = readBoardChartPalette(container);
      chart.applyOptions({
        layout: { textColor: next.ink },
        grid: { vertLines: { color: next.grid }, horzLines: { color: next.grid } },
        rightPriceScale: { borderColor: next.grid },
        timeScale: { borderColor: next.grid },
      });
      candlesSeries.applyOptions({
        upColor: next.up,
        downColor: next.down,
        borderUpColor: next.up,
        borderDownColor: next.down,
        wickUpColor: next.up,
        wickDownColor: next.down,
      });
      fast.applyOptions({ color: next.accent });
      slow.applyOptions({ color: next.ink });
    });
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-vex-theme"] });

    // The frame follows the card's width until the reader takes the viewport.
    readerMovedRef.current = false;
    const markReaderMoved = () => {
      readerMovedRef.current = true;
    };
    // A pinch zooms about the pointer. A plain vertical wheel is left alone so
    // the chat scrolls; a horizontal one is the library's pan.
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey && event.deltaY !== 0) {
        const range = chart.timeScale().getVisibleLogicalRange();
        const x = event.clientX - container.getBoundingClientRect().left;
        const anchor = chart.timeScale().coordinateToLogical(x);
        if (range === null || anchor === null) return;
        event.preventDefault();
        markReaderMoved();
        chart.timeScale().setVisibleLogicalRange(pinchRange(range, anchor, event.deltaY));
        return;
      }
      if (event.deltaX !== 0) markReaderMoved();
    };
    container.addEventListener("pointerdown", markReaderMoved);
    container.addEventListener("wheel", onWheel, { passive: false });
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const frame = frameRef.current;
            if (frame === null || readerMovedRef.current || container.clientWidth === 0) return;
            chart.timeScale().setVisibleLogicalRange(frame);
          });
    resizeObserver?.observe(container);

    // Older history when the reader nears the left edge.
    const onRange = (range: LogicalRange | null) => {
      const load = loadOlderRef.current;
      const held = heldRef.current;
      if (range === null || load === undefined || held.length === 0) return;
      if (range.from > LOAD_OLDER_WITHIN_BARS || loadingOlderRef.current || historyEndRef.current) return;
      loadingOlderRef.current = true;
      const requestedFor = held;
      void load(held[0]!.t)
        .then((older) => {
          // A new subject or read replaced the series while this was in flight.
          if (chartRef.current !== chart || heldRef.current !== requestedFor || older === null) return;
          const { merged, added } = prependOlder(requestedFor, older);
          if (added === 0) {
            historyEndRef.current = true;
            return;
          }
          const before = chart.timeScale().getVisibleLogicalRange();
          heldRef.current = merged;
          drawSeries(merged);
          if (before !== null) {
            chart.timeScale().setVisibleLogicalRange({ from: before.from + added, to: before.to + added });
          }
        })
        .finally(() => {
          loadingOlderRef.current = false;
        });
    };
    chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

    return () => {
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      resizeObserver?.disconnect();
      container.removeEventListener("pointerdown", markReaderMoved);
      container.removeEventListener("wheel", onWheel);
      themeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      fastRef.current = null;
      slowRef.current = null;
    };
  }, [subjectKey, precision]);

  function drawSeries(series: readonly TechnicalAnalysisCandle[]): void {
    candleRef.current?.setData(
      series.map((candle) => ({
        time: toTime(candle.t),
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
      })),
    );
    fastRef.current?.setData(lineData(series, 20));
    slowRef.current?.setData(lineData(series, 50));
  }

  // ── Data. Every read is a whole closed series, so it is always setData. ─
  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null || candleRef.current === null) return;
    heldRef.current = candles;
    historyEndRef.current = false;
    drawSeries(candles);
    const frame = analysisWindowRange(candles.length, windowBars);
    frameRef.current = frame;
    chart.timeScale().setVisibleLogicalRange(frame);
  }, [candles, windowBars, subjectKey, precision]);

  return (
    <figure className="m-0">
      <div ref={containerRef} role="img" aria-label={label} className="h-56 w-full" />
      <figcaption className="mt-1.5 flex flex-wrap gap-x-4 text-[12px] leading-4 text-ink-tertiary">
        <span>
          <span aria-hidden="true" className="mr-1.5 inline-block h-px w-3 bg-accent-primary align-middle" />
          EMA 20
        </span>
        <span>
          <span aria-hidden="true" className="mr-1.5 inline-block h-px w-3 bg-ink-primary align-middle" />
          EMA 50
        </span>
      </figcaption>
      <ChartAttribution />
    </figure>
  );
}
