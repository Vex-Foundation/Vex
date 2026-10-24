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
 * every resize until the reader drags the chart, and never after.
 *
 * THE WHEEL BELONGS TO THE TRANSCRIPT. The card sits in a scrolling chat, and
 * the library's default wheel handling panned and zoomed the chart whenever a
 * page scroll passed over it, sliding it back into the warm-up bars. Wheel
 * scroll and wheel zoom are off; the reader pans by dragging, and a vertical
 * touch swipe scrolls the page.
 *
 * The EMA lines are computed HERE with `@vex-lib/indicators`, the same module
 * the engine reads, over every candle read, so they are warm across the whole
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
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import { ema } from "@vex-lib/indicators/index.js";
import type { TechnicalAnalysisCandle } from "@shared/schemas/technical-analysis.js";
import { ChartAttribution } from "../Board/BoardChart.js";
import { prefersReducedMotion, readBoardChartPalette } from "../Board/boardChartTheme.js";

export interface TechnicalAnalysisChartProps {
  /** Identity of what is drawn. A change means a new chart and a new fit. */
  readonly subjectKey: string;
  readonly candles: readonly TechnicalAnalysisCandle[];
  /** Closed bars the card's numbers cover: the newest this many are framed. */
  readonly windowBars: number;
  /** Accessible name for the chart figure. */
  readonly label: string;
}

/**
 * The logical range that frames the newest `windowBars` of `count` bars, with
 * one empty slot on the right so the last candle does not touch the axis.
 */
export function analysisWindowRange(count: number, windowBars: number): { from: number; to: number } {
  const shown = Math.max(1, Math.min(count, Math.floor(windowBars)));
  return { from: count - shown - 0.5, to: count + 0.5 };
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

export function TechnicalAnalysisChart({ subjectKey, candles, windowBars, label }: TechnicalAnalysisChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const fastRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  const slowRef = useRef<ISeriesApi<"Line", Time> | null>(null);
  /** The frame the data effect last chose; the resize observer re-applies it. */
  const frameRef = useRef<{ from: number; to: number } | null>(null);
  /** Set by the reader's first drag or pinch: from then on the viewport is theirs. */
  const readerMovedRef = useRef(false);
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
      timeScale: { borderColor: palette.grid, timeVisible: true },
      kineticScroll: { touch: !reduced, mouse: false },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
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
    container.addEventListener("pointerdown", markReaderMoved);
    const resizeObserver =
      typeof ResizeObserver === "undefined"
        ? null
        : new ResizeObserver(() => {
            const frame = frameRef.current;
            if (frame === null || readerMovedRef.current || container.clientWidth === 0) return;
            chart.timeScale().setVisibleLogicalRange(frame);
          });
    resizeObserver?.observe(container);

    return () => {
      resizeObserver?.disconnect();
      container.removeEventListener("pointerdown", markReaderMoved);
      themeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      fastRef.current = null;
      slowRef.current = null;
    };
  }, [subjectKey, precision]);

  // ── Data. Every read is a whole closed series, so it is always setData. ─
  useEffect(() => {
    const chart = chartRef.current;
    const series = candleRef.current;
    if (chart === null || series === null) return;
    series.setData(
      candles.map((candle) => ({
        time: toTime(candle.t),
        open: candle.o,
        high: candle.h,
        low: candle.l,
        close: candle.c,
      })),
    );
    fastRef.current?.setData(lineData(candles, 20));
    slowRef.current?.setData(lineData(candles, 50));
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
