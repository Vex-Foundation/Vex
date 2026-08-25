/**
 * BOARD CHART - the React owner of one lightweight-charts instance.
 *
 * The chart is an imperative, DOM-owning, self-measuring object: `createChart`
 * appends its own element into our container, installs a `ResizeObserver` on
 * that container, and holds a pending animation frame. None of that survives a
 * React re-render and none of it belongs in React state, so the instance lives
 * in a ref, is created exactly once per subject inside an effect, and is
 * released by `chart.remove()` in that effect's cleanup. `remove()` is a
 * complete teardown - listeners, the RAF, the ResizeObserver, the chart's DOM
 * node and even our formatter closures - which is also what makes React
 * StrictMode's double-invoked effects safe here.
 *
 * CREATION IS GATED ON VISIBILITY, not merely on rendering. The board's chart
 * lives inside an `ExpandRegion`, which keeps its children mounted once
 * opened. A chart created while that region is collapsed is created into a
 * zero-height container, and every viewport-preservation branch inside the
 * library is behind a "the time scale has non-zero width" guard - so the
 * chart would re-derive its whole range on the first real resize, which the
 * user sees as the chart jumping the moment the region opens. The `open` prop
 * gates the effect: the container div is always rendered (so the region has a
 * stable height to animate), and the INSTANCE exists only while open. Closing
 * runs the cleanup, which detaches the primitives.
 *
 * VIEWPORT: `fitContent()` is called exactly once per subject, when that
 * subject's data first lands. It is never called on a refresh. Data arriving
 * is not a user gesture, and `fitContent`/`resetTimeScale`/`scrollToRealTime`
 * all discard the reader's zoom and scroll by design.
 *
 * OPTIONS ARE A CLOSED OBJECT built in this file. Nothing from the persisted
 * spec is ever spread into it: the spec carries no colors, classes or chart
 * options by contract, and building the object literally is what keeps that
 * true no matter what a future spec field is named.
 *
 * LABELS ARE NEVER DRAWN BY THE LIBRARY. Price lines carry no `title`, and
 * markers carry no text. The words live in the React legend rendered below
 * the canvas, where they are selectable, translatable and reachable by a
 * screen reader.
 */

import { useEffect, useMemo, useRef, type JSX } from "react";
import {
  CandlestickSeries,
  createChart,
  createSeriesMarkers,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type ISeriesMarkersPluginApi,
  type Time,
} from "lightweight-charts";
import {
  BOARD_CHART_MAX_BARS,
  CandleFeed,
  barsToPush,
  formatChartAxisPrice,
  normalizeBoardBars,
  toDisplayPrice,
  toDisplayTimeSec,
  type BoardCandleInput,
} from "./boardChartFeed.js";
import {
  prefersReducedMotion,
  readBoardChartPalette,
} from "./boardChartTheme.js";
import { PriceZonePrimitive, type PriceZoneBand } from "./priceZonePrimitive.js";
import type { BoardChartResolution } from "@vex-lib/board/index.js";
import type { BoardAnnotationRow } from "./boardModel.js";

/** A level annotation, still carrying its decimal string. */
export interface BoardChartLevel {
  readonly key: string;
  readonly price: string;
}

/** A zone annotation, still carrying its decimal strings. */
export interface BoardChartZone {
  readonly key: string;
  readonly priceFrom: string;
  readonly priceTo: string;
}

/** A marker annotation, still carrying its epoch-milliseconds instant. */
export interface BoardChartMarker {
  readonly key: string;
  readonly atMs: number;
}

export interface BoardChartProps {
  /** Identity of what is being shown. A change means a new chart. */
  readonly subjectKey: string;
  /** Whether the enclosing disclosure region is open. Gates creation. */
  readonly open: boolean;
  /** The pinned resolution vocabulary, not a free string. */
  readonly resolution: BoardChartResolution;
  readonly bars: readonly BoardCandleInput[];
  readonly levels: readonly BoardChartLevel[];
  readonly zones: readonly BoardChartZone[];
  readonly markers: readonly BoardChartMarker[];
  /** Annotation labels, rendered as text below the canvas. */
  readonly annotationRows: readonly BoardAnnotationRow[];
  /** Accessible name for the chart figure. */
  readonly label: string;
  /** True when the forming bar is incomplete, stated in words below. */
  readonly lastBarPartial: boolean;
  /** True when the provider itself bounded the range it returned. */
  readonly truncated: boolean;
}

const CHART_HEIGHT_CLASS = "h-64";

export function BoardChart({
  subjectKey,
  open,
  resolution,
  bars,
  levels,
  zones,
  markers,
  annotationRows,
  label,
  lastBarPartial,
  truncated,
}: BoardChartProps): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick", Time> | null>(null);
  const feedRef = useRef<CandleFeed | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  const zonesRef = useRef<PriceZonePrimitive | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const fittedSubjectRef = useRef<string | null>(null);

  // Normalization is the adapter's job and it is memoized on the bars
  // identity, so a parent re-render does not re-sort a 200-row array.
  const normalized = useMemo(() => normalizeBoardBars(bars), [bars]);

  // A series with no bars is a real outcome (the provider had no candles for
  // this pool at this resolution), and it is NOT a chart. Creating one would
  // paint an empty grid that reads as a broken chart rather than as an honest
  // "no candles". The degradation is a stated line instead - the board's
  // cards, notes and annotation labels all still render.
  const hasSeries = normalized.bars.length > 0;

  // ── The chart instance. One per (subject, open) - nothing else. ────────
  useEffect(() => {
    if (!open || !hasSeries) return;
    const container = containerRef.current;
    if (container === null) return;

    const palette = readBoardChartPalette(container);
    const reduced = prefersReducedMotion();

    const chart = createChart(container, {
      autoSize: true,
      layout: {
        // Removes the library's outbound anchor to tradingview.com, which it
        // injects via innerHTML. Attribution is rendered as owned React text
        // and a link below the canvas instead.
        attributionLogo: false,
        background: { color: "transparent" },
        textColor: palette.ink,
        fontSize: 11,
      },
      grid: {
        vertLines: { color: palette.grid },
        horzLines: { color: palette.grid },
      },
      rightPriceScale: { borderColor: palette.grid },
      timeScale: {
        borderColor: palette.grid,
        // The library compensates rightOffset when bars are appended and the
        // newest bar is NOT visible, so a reader scrolled back into history
        // is never yanked forward. Leaving this on gives the desirable
        // "follow only if you were already at the edge" behavior.
        shiftVisibleRangeOnNewBar: true,
        timeVisible: true,
      },
      // Kinetic scroll is the only genuinely inertial motion the library has.
      kineticScroll: { touch: !reduced, mouse: false },
      handleScale: { axisPressedMouseMove: false },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.up,
      borderDownColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
      // Set ONCE at creation: passing priceFormat through applyOptions forces
      // a full chart update, so it must not ride a per-theme or per-tick call.
      priceFormat: { type: "custom", formatter: formatChartAxisPrice, minMove: 0 },
    });

    const markerPlugin = createSeriesMarkers<Time>(series, []);
    const zonePrimitive = new PriceZonePrimitive();
    series.attachPrimitive(zonePrimitive);

    chartRef.current = chart;
    seriesRef.current = series;
    feedRef.current = new CandleFeed(series);
    markersRef.current = markerPlugin;
    zonesRef.current = zonePrimitive;
    priceLinesRef.current = [];
    fittedSubjectRef.current = null;

    // Theme repointing without a rebuild: `data-vex-theme` flips the aliases,
    // and applyOptions re-reads them. Colors alone do not force a full update.
    const root = document.documentElement;
    const themeObserver = new MutationObserver(() => {
      const next = readBoardChartPalette(container);
      chart.applyOptions({
        layout: { textColor: next.ink },
        grid: {
          vertLines: { color: next.grid },
          horzLines: { color: next.grid },
        },
        rightPriceScale: { borderColor: next.grid },
        timeScale: { borderColor: next.grid },
      });
      series.applyOptions({
        upColor: next.up,
        downColor: next.down,
        borderUpColor: next.up,
        borderDownColor: next.down,
        wickUpColor: next.up,
        wickDownColor: next.down,
      });
    });
    themeObserver.observe(root, {
      attributes: true,
      attributeFilter: ["data-vex-theme"],
    });

    const motionQuery =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : null;
    const onMotionChange = (): void => {
      chart.applyOptions({
        kineticScroll: { touch: !(motionQuery?.matches ?? false), mouse: false },
      });
    };
    motionQuery?.addEventListener("change", onMotionChange);

    return () => {
      motionQuery?.removeEventListener("change", onMotionChange);
      themeObserver.disconnect();
      // Detach before remove so the primitive's `detached()` runs and drops
      // its captured requestUpdate; after `remove()` every handle we hold is
      // dangling, so they are nulled in the same statement block.
      series.detachPrimitive(zonePrimitive);
      markerPlugin.detach();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      feedRef.current = null;
      markersRef.current = null;
      zonesRef.current = null;
      priceLinesRef.current = [];
      fittedSubjectRef.current = null;
    };
  }, [open, hasSeries, subjectKey]);

  // ── Data. setData on a subject change, update on a refresh. ────────────
  useEffect(() => {
    const feed = feedRef.current;
    const chart = chartRef.current;
    if (feed === null || chart === null) return;

    if (fittedSubjectRef.current !== subjectKey) {
      feed.reset(normalized.bars);
      // The one sanctioned viewport reset: a different subject is a
      // deliberate change of what the chart is about, not data arriving.
      chart.timeScale().fitContent();
      fittedSubjectRef.current = subjectKey;
      return;
    }
    // Same subject, fresher hydration: write only the tail, forming bar
    // included. `push` drops anything older than what is held rather than
    // letting the library throw its production `Cannot update oldest data`.
    for (const bar of barsToPush(normalized.bars, feed.newestTimeSec)) {
      feed.push(bar);
    }
  }, [normalized, subjectKey, open]);

  // ── Annotations. Geometry only; the words are in the legend below. ─────
  useEffect(() => {
    const series = seriesRef.current;
    const container = containerRef.current;
    if (series === null || container === null) return;
    const palette = readBoardChartPalette(container);

    for (const line of priceLinesRef.current) {
      series.removePriceLine(line);
    }
    priceLinesRef.current = levels.flatMap((level) => {
      const price = toDisplayPrice(level.price);
      if (price === null) return [];
      return [
        series.createPriceLine({
          price,
          color: palette.accent,
          lineWidth: 1,
          // No `title`, no axis label: canvas text is unreachable by a screen
          // reader and unselectable. The label is React text in the legend.
          axisLabelVisible: false,
          title: "",
        }),
      ];
    });

    const bands: PriceZoneBand[] = zones.flatMap((zone) => {
      const from = toDisplayPrice(zone.priceFrom);
      const to = toDisplayPrice(zone.priceTo);
      if (from === null || to === null) return [];
      return [{ from, to, fill: palette.zone }];
    });
    zonesRef.current?.setBands(bands);

    markersRef.current?.setMarkers(
      markers.flatMap((marker) => {
        const time = toDisplayTimeSec(marker.atMs);
        if (time === null) return [];
        return [
          {
            time,
            position: "aboveBar" as const,
            shape: "arrowDown" as const,
            color: palette.accent,
          },
        ];
      }),
    );
  }, [levels, zones, markers, subjectKey, open]);

  return (
    <figure
      data-vex-area="board-chart"
      data-open={open ? "true" : "false"}
      className="m-0 flex flex-col gap-2"
    >
      {hasSeries ? (
        <div
          ref={containerRef}
          data-vex-area="board-chart-canvas"
          role="img"
          aria-label={label}
          className={`w-full ${CHART_HEIGHT_CLASS} overflow-hidden rounded-lg border border-line-2 bg-surface-1`}
        />
      ) : (
        <p
          data-vex-area="board-chart-empty"
          className={`flex w-full ${CHART_HEIGHT_CLASS} items-center justify-center rounded-lg border border-line-2 bg-surface-1 text-[11px] text-ink-tertiary`}
        >
          No candles for this pool at {resolution}.
        </p>
      )}
      <ChartCaveats
        resolution={resolution}
        drawn={normalized.bars.length}
        hiddenOlder={normalized.hiddenOlder}
        whitespaceCount={normalized.whitespaceCount}
        lastBarPartial={lastBarPartial}
        truncated={truncated}
      />
      <AnnotationLegend rows={annotationRows} />
      <ChartAttribution />
    </figure>
  );
}

/**
 * What the chart is NOT showing, in words. A display bound that bites is
 * reported rather than hidden: the reader is told how many older bars exist
 * beyond the drawn window, that a leg-less bucket reserved its slot without a
 * candle, and that the newest bar is still forming.
 */
function ChartCaveats({
  resolution,
  drawn,
  hiddenOlder,
  whitespaceCount,
  lastBarPartial,
  truncated,
}: {
  readonly resolution: BoardChartResolution;
  readonly drawn: number;
  readonly hiddenOlder: number;
  readonly whitespaceCount: number;
  readonly lastBarPartial: boolean;
  readonly truncated: boolean;
}): JSX.Element {
  const caveats: string[] = [];
  if (hiddenOlder > 0) {
    caveats.push(
      `${hiddenOlder} older ${hiddenOlder === 1 ? "bar" : "bars"} beyond the ${BOARD_CHART_MAX_BARS}-bar window`,
    );
  }
  if (whitespaceCount > 0) {
    caveats.push(
      `${whitespaceCount} ${whitespaceCount === 1 ? "bucket" : "buckets"} with no price`,
    );
  }
  if (lastBarPartial) caveats.push("newest bar still forming");
  if (truncated) caveats.push("provider bounded the range");

  return (
    <figcaption
      data-vex-area="board-chart-caveats"
      className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-tertiary"
    >
      <span className="vex-micro-label uppercase text-ink-secondary">
        {resolution}
      </span>
      <span className="tabular-nums">
        {drawn} {drawn === 1 ? "bar" : "bars"}
      </span>
      {caveats.map((caveat) => (
        <span key={caveat}>{caveat}</span>
      ))}
    </figcaption>
  );
}

/**
 * The agent's annotations as text. Rendering nothing when there are none
 * keeps the block inert rather than showing an empty heading.
 */
function AnnotationLegend({
  rows,
}: {
  readonly rows: readonly BoardAnnotationRow[];
}): JSX.Element | null {
  if (rows.length === 0) return null;
  return (
    <ul
      data-vex-area="board-chart-annotations"
      aria-label="Chart annotations"
      // A board decimal may be 40 characters wide. The list scrolls inside its
      // OWN container so a long coordinate never widens the transcript column;
      // nothing is clipped, because the row scrolls rather than truncating.
      className="flex max-w-full flex-col gap-1 overflow-x-auto"
    >
      {rows.map((row) => (
        <li
          key={row.key}
          data-annotation-kind={row.kind}
          className="flex w-max items-baseline gap-2 whitespace-nowrap text-[11px]"
        >
          <span className="vex-micro-label uppercase text-ink-secondary">
            {row.kind}
          </span>
          <span className="text-ink-primary">{row.label}</span>
          <span className="tabular-nums text-ink-tertiary">
            {row.coordinate}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Owned attribution. The library's built-in logo widget is disabled because
 * it injects an anchor to an external origin through `innerHTML` inside a
 * privileged renderer; this is the same credit as static, reviewable markup.
 * `dexscreener.com` and `tradingview.com` both route through main's
 * external-URL allowlist, so `target=_blank` opens the system browser rather
 * than a child window.
 */
function ChartAttribution(): JSX.Element {
  return (
    <p
      data-vex-area="board-chart-attribution"
      className="text-[10px] text-ink-caption"
    >
      Charting by{" "}
      <a
        href="https://www.tradingview.com/"
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        TradingView Lightweight Charts
      </a>
    </p>
  );
}
