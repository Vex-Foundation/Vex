/**
 * SPOTLIGHT CHART - the live area chart of the owner's mockup, and the ONLY
 * imperative writer of its series.
 *
 * WHY A DEDICATED COMPONENT AND NOT AN OPTION ON `BoardChart`. They are two
 * products. `BoardChart` draws a PERSISTED analyst snapshot: candles the
 * agent composed, annotations it authored, a fixed range, no feed. This draws
 * a LIVE line: one derived value per bucket, a resolution the reader picks, a
 * poll on a timer, a reconciliation contract, a crosshair readout and a
 * teardown on three different exits. Folding the second into the first would
 * put a feed lifecycle inside a component whose whole contract is that it has
 * none (A8).
 *
 * THE SERIES HAS ONE WRITER. `AreaFeed` is created here, held in a ref, and
 * every `setData` / `update` goes through it. Nothing else in the renderer
 * may touch the series, which is what makes the reconciliation table below a
 * complete account of what the chart can do.
 *
 * WHAT THE RECONCILIATION PRESERVES, and why it is by TIMESTAMP SET rather
 * than by length. A rolling window that replaced a constant number of bars
 * looks correct to a reader sitting at the live edge and silently drags a
 * reader who has scrolled back into history. So a poll is compared against
 * what is held as SETS OF TIMES (`reconcileAreaSeries`): times that left,
 * times that arrived, times whose value changed. When the plan is a full
 * replace AND the reader is not at the edge, the VISIBLE TIME RANGE is
 * captured before the write and restored after it, so the bars they were
 * reading stay under their eyes.
 *
 * "SCROLLED BACK" IS A LIBRARY FACT, NOT A GUESS:
 * `series.barsInLogicalRange(...).barsAfter > 0` means the newest bar is off
 * screen. Nothing here reimplements the library's own autoscroll gate.
 *
 * VIEWPORT RESETS ARE A USER GESTURE ONLY. `fitContent()` runs exactly once
 * per subject (pool plus pill) - a pill click IS the reader asking for a
 * different time frame. It never runs on a poll, and `resetTimeScale` and
 * `scrollToRealTime` are never called at all.
 *
 * PRECISION IS FIXED BY THE SEED and changed, if it ever must, through
 * `applyOptions` - never by rebuilding the instance. Reformatting the axis
 * under a reader mid-read is a worse defect than one fewer decimal place, so
 * the escape hatch fires at most once per subject and never while the
 * crosshair is up.
 *
 * THE KEYBOARD READOUT IS A REAL FEATURE, not an ARIA label. The chart region
 * is focusable, the arrow keys move a bar cursor, and the same figures the
 * tooltip shows are written into a polite live region. `setCrosshairPosition`
 * SUPPRESSES the move event, so the readout is updated directly rather than
 * waiting for a subscription that will not fire.
 *
 * WHAT LIVES ELSEWHERE, and why. This file is the IMPERATIVE KERNEL: the
 * instance, the feed, the crosshair subscription, the bar cursor and the
 * teardown, all of which share one lifecycle owner and are not split by line
 * count. Four things around it do not share that lifecycle and have their own
 * names and their own tests: the pill vocabulary (`spotlightChartPills`), the
 * UTC time vocabulary the axis and the tooltip both speak
 * (`spotlightChartTime`), the tooltip's placement geometry
 * (`spotlightChartTooltipPlacement`) and the surface state machine
 * (`spotlightChartState`). The caption, which carries the licence notice in
 * every state, is `SpotlightChartCaption`.
 *
 * TEARDOWN ORDER IS FIXED (contract 6.1): the FEED is cut before anything
 * imperative is released, because a response landing between a primitive
 * detach and `chart.remove()` would write to a half-disposed series. Leaving
 * the spotlight and closing the modal unmount this component; the lease
 * ending only cuts the feed, because the bars already drawn are real data
 * that was really fetched and clearing them would be a lie about the market.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type JSX,
  type KeyboardEvent,
} from "react";
import {
  AreaSeries,
  CrosshairMode,
  LastPriceAnimationMode,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type MouseEventParams,
  type Time,
  type UTCTimestamp,
} from "lightweight-charts";
import type { BoardChartPillResolution } from "@shared/schemas/board-chart.js";
import { cn } from "../../../lib/utils.js";
import {
  AreaFeed,
  chartPriceDecimals,
  createChartAxisPriceFormatter,
  minMoveForDecimals,
  normalizeBoardAreaPoints,
  reconcileAreaSeries,
  type BoardChartAreaPoint,
} from "./boardChartFeed.js";
import {
  prefersReducedMotion,
  readBoardChartPalette,
} from "./boardChartTheme.js";
import { formatBoardUtcClock } from "./boardFormat.js";
import {
  tooltipStamp,
  utcTickMarkFormatter,
  utcTimeFormatter,
} from "./spotlightChartTime.js";
import { placeSpotlightTooltip } from "./spotlightChartTooltipPlacement.js";
import {
  spotlightChartSurfaceState,
  type SpotlightChartSurfaceState,
} from "./spotlightChartState.js";
import { SpotlightChartCaption } from "./SpotlightChartCaption.js";
import {
  PILL_LABEL,
  SPOTLIGHT_CHART_DEFAULT_PILL,
  SPOTLIGHT_PILLS,
} from "./spotlightChartPills.js";
import type { BoardSpotlightChartSlotProps } from "./BoardSpotlight.js";
import { useSpotlightCandles, type SpotlightCandles } from "./spotlight-channels.js";

/* ------------------------------------------------------------------ */
/* The pills                                                           */
/* ------------------------------------------------------------------ */

// Re-exported at the surface's own entry point: the vocabulary moved to its
// own module, the public gate did not move.
export {
  PILL_LABEL,
  SPOTLIGHT_CHART_DEFAULT_PILL,
  SPOTLIGHT_PILLS,
} from "./spotlightChartPills.js";

const CHART_ABSENT_COPY: Readonly<Record<string, string>> = {
  no_drawable_bars: "This pool has no drawable price history at this resolution yet.",
  unknown_pair: "The provider does not index this pool.",
  transport: "Could not reach the provider for these candles.",
  provider: "The provider did not answer this read.",
  busy: "The board is busy with other reads. This one is retried.",
  not_mounted: "The chart feed is not available in this build.",
  cancelled: "This read was cancelled.",
};

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface Tooltip {
  readonly priceText: string;
  readonly timeText: string;
  readonly x: number;
  readonly y: number;
}

/**
 * The card's clearances, in CSS pixels.
 *
 * These are GEOMETRY, not design values: the gap is how far the card sits off
 * the dot it describes and the margin is how close it may come to the pane's
 * edge. Every colour, radius and type size around them is still a token.
 */
const TOOLTIP_GAP_PX = 14;
const TOOLTIP_MARGIN_PX = 8;

/** What a failed refresh is called, when there are last-good bars to keep. */
const CHART_DEGRADED_COPY: Readonly<Record<string, string>> = {
  transport: "Could not reach the provider for the latest candles.",
  provider: "The provider did not answer the latest read.",
  busy: "The board is busy with other reads; this refresh is retried.",
  cancelled: "The latest refresh was cancelled.",
  unknown_pair: "The provider stopped indexing this pool.",
  no_drawable_bars: "The latest read had no drawable buckets.",
  not_mounted: "The chart feed is not available in this build.",
};

export function SpotlightChart({
  subject,
  live,
  fetchedAtMs,
}: BoardSpotlightChartSlotProps): JSX.Element {
  const [resolution, setResolution] = useState<BoardChartPillResolution>(
    SPOTLIGHT_CHART_DEFAULT_PILL,
  );
  const read = useSpotlightCandles({ subject, active: true, live, resolution });

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Area", Time> | null>(null);
  const feedRef = useRef<AreaFeed | null>(null);
  const fittedSubjectRef = useRef<string | null>(null);
  const decimalsRef = useRef<number | null>(null);
  const decimalsSubjectRef = useRef<string | null>(null);

  /**
   * Bumped when an INSTANCE exists.
   *
   * The data effect cannot depend on the refs the creation effect fills: the
   * commit that creates the chart is the commit AFTER the one the first page
   * landed in, so `normalized` is unchanged by then and a deps array of data
   * alone would leave the seed unwritten until the next poll. This epoch is
   * the "there is something to write to" fact, and it belongs in the deps.
   */
  const [instanceEpoch, setInstanceEpoch] = useState(0);
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const tooltipRef = useRef<Tooltip | null>(null);
  tooltipRef.current = tooltip;
  const [readout, setReadout] = useState<string>("");
  const tooltipElRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<number | null>(null);
  const [paletteEpoch, setPaletteEpoch] = useState(0);

  const subjectKey = `${subject.chain}/${subject.pairAddress}/${resolution}`;
  const poolKey = `${subject.chain}/${subject.pairAddress}`;
  const gradientId = `vex-spotlight-glow-${useId().replace(/:/g, "")}`;

  /**
   * WHAT THIS SURFACE IS SHOWING, as one closed state.
   *
   * `degraded` is the state A8 and A11 both require and the surface used to
   * lack: a failed refresh over bars that are still real. The last-good page
   * and its clock belong to the CHANNEL (`SpotlightRead.lastGood`), which is
   * where they survive consecutive failures; this only decides what to draw.
   */
  const surface: SpotlightChartSurfaceState = spotlightChartSurfaceState({
    read,
    resolution,
  });

  // The page on screen must be OF the pill on screen. See `forResolution`.
  const series = surface.kind === "ready" ? surface.page.series : null;
  const normalized = useMemo(
    () => normalizeBoardAreaPoints(series?.bars ?? []),
    [series],
  );

  /**
   * The instance exists from the first landed page of THIS POOL onward.
   *
   * Gated on data because a chart with no series is an empty grid that reads
   * as broken, and gated on the POOL rather than on the pill because a pill
   * switch must not destroy and rebuild the canvas (contract 3.4): that is
   * new canvases, a new ResizeObserver and a visible flash for what is only a
   * `setData`.
   */
  const [hasEverDrawn, setHasEverDrawn] = useState(false);
  useEffect(() => {
    setHasEverDrawn(false);
    fittedSubjectRef.current = null;
    decimalsRef.current = null;
    decimalsSubjectRef.current = null;
  }, [poolKey]);
  useEffect(() => {
    if (normalized.points.length > 0) setHasEverDrawn(true);
  }, [normalized]);

  // The seed's precision, fixed for the life of this subject (contract 7.3).
  if (decimalsSubjectRef.current !== subjectKey && series !== null) {
    decimalsSubjectRef.current = subjectKey;
    decimalsRef.current = chartPriceDecimals(series.bars);
  }
  const decimals = decimalsRef.current ?? 6;

  const priceText = useCallback(
    (value: number): string =>
      createChartAxisPriceFormatter(decimalsRef.current ?? decimals)(value),
    [decimals],
  );

  /* ---------------- the instance, its handlers, its teardown -------- */

  useEffect(() => {
    if (!hasEverDrawn) return;
    const container = containerRef.current;
    if (container === null) return;

    const palette = readBoardChartPalette(container);
    const reduced = prefersReducedMotion();
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        // OFF, and the credit is rendered as our own text below the canvas
        // instead: an anchor a screen reader can reach and a keyboard can
        // focus, rather than a bitmap in a corner.
        attributionLogo: false,
        background: { color: "transparent" },
        textColor: palette.ink,
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: palette.grid, style: 2 },
      },
      // THE MOCKUP'S AXIS IS ON THE LEFT and there is no right-hand rail.
      leftPriceScale: { visible: true, borderVisible: false },
      rightPriceScale: { visible: false },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
        // THE AXIS, IN UTC. `localization.timeFormatter` below formats the
        // CROSSHAIR label only; the tick marks are this formatter's, and the
        // library's default for them is the VIEWER'S LOCAL TIMEZONE. Both are
        // set, from one module, so the axis and the tooltip cannot disagree.
        tickMarkFormatter: utcTickMarkFormatter,
      },
      crosshair: { mode: CrosshairMode.Magnet },
      // EXPLICIT UTC. An unlabelled axis is read as local time by everyone,
      // and this chart is compared against a UTC-stamped board header.
      localization: { timeFormatter: utcTimeFormatter },
      kineticScroll: { touch: !reduced, mouse: false },
      handleScale: { axisPressedMouseMove: { time: true, price: false } },
    });

    const areaSeries = chart.addSeries(AreaSeries, {
      lineColor: palette.up,
      topColor: withAlpha(palette.up, 0.28),
      bottomColor: withAlpha(palette.up, 0),
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: true,
      crosshairMarkerRadius: 4,
      pointMarkersVisible: false,
      lastPriceAnimation: LastPriceAnimationMode.Disabled,
      priceFormat: {
        type: "price",
        precision: decimalsRef.current ?? decimals,
        minMove: minMoveForDecimals(decimalsRef.current ?? decimals),
      },
    });
    // The formatter and the tick share ONE precision, which is the invariant
    // that stopped an axis from printing floating-point residue.
    chart.applyOptions({
      localization: {
        timeFormatter: utcTimeFormatter,
        priceFormatter: createChartAxisPriceFormatter(decimalsRef.current ?? decimals),
      },
    });

    chartRef.current = chart;
    seriesRef.current = areaSeries;
    feedRef.current = new AreaFeed({
      setData: (data) => {
        areaSeries.setData(data);
      },
      update: (point, historicalUpdate) => {
        areaSeries.update(point, historicalUpdate);
      },
    });

    /**
     * The crosshair handler. ANCHORED IN CHART COORDINATES, not at the
     * pointer: the crosshair is magnetic, so it snaps to the series value,
     * and a tooltip placed at the mouse would sit off the dot it describes.
     */
    const onCrosshair = (param: MouseEventParams<Time>): void => {
      const time = param.time;
      if (time === undefined || param.point === undefined) {
        setTooltip(null);
        return;
      }
      const point = param.seriesData.get(areaSeries);
      const value =
        point !== undefined && "value" in point ? (point.value as number) : null;
      if (value === null) {
        setTooltip(null);
        return;
      }
      const x = chart.timeScale().timeToCoordinate(time);
      const y = areaSeries.priceToCoordinate(value);
      if (x === null || y === null) {
        setTooltip(null);
        return;
      }
      setTooltip({
        priceText: createChartAxisPriceFormatter(decimalsRef.current ?? decimals)(
          value,
        ),
        timeText: tooltipStamp(time as UTCTimestamp),
        x,
        y,
      });
    };
    chart.subscribeCrosshairMove(onCrosshair);

    // A THEME FLIP IS AN `applyOptions`, NEVER A REBUILD. Recreating the
    // instance would throw away the reader's zoom and pan for a colour
    // change, so the aliases are re-read and pushed into the LIVE chart and
    // series exactly as `BoardChart` does. The epoch is bumped only so the
    // effects that derive from the palette re-run; the creation effect does
    // NOT depend on it.
    const themeObserver = new MutationObserver(() => {
      const next = readBoardChartPalette(container);
      chart.applyOptions({
        layout: { textColor: next.ink },
        grid: { horzLines: { color: next.grid } },
      });
      areaSeries.applyOptions({
        lineColor: next.up,
        topColor: withAlpha(next.up, 0.28),
        bottomColor: withAlpha(next.up, 0),
      });
      setPaletteEpoch((epoch) => epoch + 1);
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-vex-theme", "class"],
    });
    setInstanceEpoch((epoch) => epoch + 1);

    return () => {
      // ORDER IS THE CONTRACT'S. Admission closes first: the feed hook owns
      // the timer and the generation, and this component's own imperative
      // handles are released only after the crosshair subscription is gone.
      chart.unsubscribeCrosshairMove(onCrosshair);
      setTooltip(null);
      themeObserver.disconnect();
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
      feedRef.current = null;
      fittedSubjectRef.current = null;
      cursorRef.current = null;
    };
    // `decimals` is deliberately NOT a dependency: a precision change is an
    // `applyOptions` below, never a rebuilt instance (contract 7.2, 7.5).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasEverDrawn, poolKey]);

  /* ---------------- data: the reconciliation ------------------------ */

  useEffect(() => {
    const feed = feedRef.current;
    const chart = chartRef.current;
    const areaSeries = seriesRef.current;
    if (feed === null || chart === null || areaSeries === null) return;
    if (normalized.points.length === 0) return;

    if (fittedSubjectRef.current !== subjectKey) {
      // A PILL CLICK IS A GESTURE, and the only sanctioned viewport reset.
      feed.reset(normalized.points);
      chart.timeScale().fitContent();
      fittedSubjectRef.current = subjectKey;
      cursorRef.current = null;
      return;
    }

    const plan = reconcileAreaSeries(feed.held, normalized.points);
    // Captured BEFORE the write, and only when the reader is not at the live
    // edge: `barsAfter > 0` is the library's own "the newest bar is off
    // screen", so this asks the chart rather than guessing.
    const logical = chart.timeScale().getVisibleLogicalRange();
    const bars = logical === null ? null : areaSeries.barsInLogicalRange(logical);
    const scrolledBack = (bars?.barsAfter ?? 0) > 0;
    const visibleBefore = scrolledBack ? chart.timeScale().getVisibleRange() : null;

    const applied = feed.apply(plan);

    if (applied.reset && visibleBefore !== null) {
      const oldest = feed.oldestTimeSec;
      const newest = feed.newestTimeSec;
      if (oldest !== null && newest !== null) {
        const from = Math.max(oldest, visibleBefore.from as number);
        const to = Math.min(newest, visibleBefore.to as number);
        // A range the trim left nothing of cannot be restored, and forcing it
        // would throw; the reader lands at the fitted view, which is honest.
        if (from < to) {
          chart
            .timeScale()
            .setVisibleRange({ from: from as UTCTimestamp, to: to as UTCTimestamp });
        }
      }
    }
  }, [normalized, subjectKey, instanceEpoch]);

  /* ---------------- options that change without a rebuild ----------- */

  useEffect(() => {
    const areaSeries = seriesRef.current;
    if (areaSeries === null) return;
    // Doubly gated (contract 5.4): a pulse implying fresh data while the feed
    // is cut is the same lie as a relative clock that keeps ticking.
    const animate = live && !prefersReducedMotion();
    areaSeries.applyOptions({
      lastPriceAnimation: animate
        ? LastPriceAnimationMode.OnDataUpdate
        : LastPriceAnimationMode.Disabled,
    });
  }, [live, hasEverDrawn, instanceEpoch, paletteEpoch]);

  useEffect(() => {
    const areaSeries = seriesRef.current;
    if (areaSeries === null) return;
    // The escape hatch, and it is guarded twice: never while the crosshair is
    // up (the numbers would re-scale under the reader's eyes), and never as a
    // recreation - `applyOptions` repaints at full invalidation and leaves the
    // viewport alone (contract 7.2).
    if (tooltipRef.current !== null) return;
    areaSeries.applyOptions({
      priceFormat: {
        type: "price",
        precision: decimals,
        minMove: minMoveForDecimals(decimals),
      },
    });
  }, [decimals]);

  /**
   * The tooltip's POSITION, written through the CSSOM.
   *
   * A coordinate that changes on every pointer move cannot be a class, and
   * this is the same mechanism the app's own `ui/tooltip` primitive uses for
   * the same reason. It is a position the LIBRARY computed
   * (`timeToCoordinate` / `priceToCoordinate`), never a design value: every
   * colour, size and offset around it is still a token.
   */
  useEffect(() => {
    const node = tooltipElRef.current;
    const container = containerRef.current;
    if (node === null || container === null || tooltip === null) return;
    const placement = placeSpotlightTooltip({
      anchor: { x: tooltip.x, y: tooltip.y },
      container: {
        width: container.clientWidth,
        height: container.clientHeight,
      },
      tooltip: { width: node.offsetWidth, height: node.offsetHeight },
      gap: TOOLTIP_GAP_PX,
      margin: TOOLTIP_MARGIN_PX,
    });
    node.style.left = `${String(placement.left)}px`;
    node.style.top = `${String(placement.top)}px`;
    node.dataset.side = placement.flippedY ? "below" : "above";
    node.dataset.clampedX = placement.clampedX ? "true" : "false";
  }, [tooltip]);

  /* ---------------- the keyboard readout ---------------------------- */

  /**
   * Move the bar cursor and speak the bar.
   *
   * `setCrosshairPosition` SUPPRESSES the crosshair-move event by design, so
   * the readout is written here rather than left to the subscription. The
   * live region carries exactly what the tooltip shows.
   */
  const moveCursor = useCallback(
    (delta: number): void => {
      const feed = feedRef.current;
      const chart = chartRef.current;
      const areaSeries = seriesRef.current;
      if (feed === null || chart === null || areaSeries === null) return;
      const held = feed.held;
      if (held.length === 0) return;
      const current = cursorRef.current ?? held.length - 1;
      const next = Math.max(0, Math.min(held.length - 1, current + delta));
      cursorRef.current = next;
      const point: BoardChartAreaPoint | undefined = held[next];
      if (point === undefined) return;
      const time = point.time as UTCTimestamp;
      if (!("value" in point)) {
        setReadout(`${tooltipStamp(time)}: no price reported for this bucket`);
        setTooltip(null);
        return;
      }

      /**
       * BRING THE BAR INTO VIEW BEFORE READING ITS COORDINATES.
       *
       * `End` and `Home` mean the newest and the oldest bar, and a reader who
       * has scrolled into history is asking to be taken there. Clamping the
       * cursor to what happens to be visible instead would answer `Home` with
       * some middle bar and call it the first, which is a worse lie than a
       * moved viewport - and outside the visible logical range
       * `timeToCoordinate` returns null, so the readout and the tooltip had no
       * coordinates to work with anyway. The WIDTH of the range is preserved,
       * so this is a scroll, not a zoom, and it happens only on the reader's
       * own key press (A8's "viewport resets are a user gesture only").
       */
      const timeScale = chart.timeScale();
      const logical = timeScale.getVisibleLogicalRange();
      if (logical !== null) {
        const from = logical.from as number;
        const to = logical.to as number;
        if (next < from || next > to) {
          const width = to - from;
          const start = next < from ? next : next - width;
          timeScale.setVisibleLogicalRange({ from: start, to: start + width });
        }
      }

      chart.setCrosshairPosition(point.value, time, areaSeries);
      const spoken = `${priceText(point.value)} at ${tooltipStamp(time)}`;
      // The readout is written from the HELD BAR, so it is right whether or
      // not the pane could give a coordinate for it.
      setReadout(spoken);
      const x = timeScale.timeToCoordinate(time);
      const y = areaSeries.priceToCoordinate(point.value);
      // No coordinate, no card: a tooltip parked at 0,0 describes the wrong
      // bar, and the live region above already carries the figures.
      setTooltip(
        x === null || y === null
          ? null
          : {
              priceText: priceText(point.value),
              timeText: tooltipStamp(time),
              x,
              y,
            },
      );
    },
    [priceText],
  );

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>): void => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveCursor(-1);
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        moveCursor(1);
        return;
      }
      if (event.key === "Home") {
        event.preventDefault();
        moveCursor(-Number.MAX_SAFE_INTEGER);
        return;
      }
      if (event.key === "End") {
        event.preventDefault();
        moveCursor(Number.MAX_SAFE_INTEGER);
        return;
      }
      if (event.key === "Escape") {
        const chart = chartRef.current;
        chart?.clearCrosshairPosition();
        cursorRef.current = null;
        setTooltip(null);
        setReadout("");
      }
    },
    [moveCursor],
  );

  /* ---------------- render ------------------------------------------ */

  const showSkeleton = surface.kind === "skeleton";
  const degraded = surface.kind === "degraded";
  // The absence panel is for the case where there is NOTHING GOOD TO SHOW.
  // A failed refresh over last-good bars is a degraded chart, not an empty
  // one, and covering real bars with an absence panel would be the lie A8
  // and A11 both forbid.
  const showAbsence = surface.kind === "absent";
  // The clock is the clock OF THE BARS ON SCREEN - the last good read while
  // degraded, never the moment the failed attempt happened.
  const stamp = formatBoardUtcClock(
    surface.kind === "ready" || surface.kind === "degraded"
      ? surface.fetchedAtMs
      : fetchedAtMs,
  );
  // A degraded chart is NOT streaming, whatever the lease says.
  const streaming = live && surface.kind === "ready";
  const notesPage: SpotlightCandles | null =
    surface.kind === "ready" || surface.kind === "degraded" ? surface.page : null;

  return (
    <figure
      data-vex-area="spotlight-chart"
      data-resolution={resolution}
      data-state={surface.kind}
      className="flex min-w-0 flex-col gap-2"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          role="tablist"
          aria-label="Chart range"
          data-vex-area="spotlight-chart-pills"
          className="flex items-center gap-1"
        >
          {SPOTLIGHT_PILLS.map((pill) => {
            const selected = pill.resolution === resolution;
            return (
              <button
                key={pill.resolution}
                type="button"
                role="tab"
                aria-selected={selected}
                data-vex-area="spotlight-chart-pill"
                data-resolution={pill.resolution}
                data-selected={selected ? "true" : "false"}
                onClick={() => {
                  setResolution(pill.resolution);
                }}
                className={cn(
                  "rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
                  selected
                    ? "bg-accent-primary text-ink-on-accent"
                    : "text-ink-tertiary hover:bg-interactive-hover hover:text-ink-primary",
                )}
              >
                {pill.label}
              </button>
            );
          })}
        </div>
        <span
          data-vex-area="spotlight-chart-status"
          data-live={streaming ? "true" : "false"}
          data-degraded={degraded ? "true" : "false"}
          className="text-[12px] leading-[16px] text-ink-tertiary"
        >
          {stamp === null ? "read at an unknown time" : `as of ${stamp}`}
        </span>
      </div>

      {/* THE DEGRADED LINE. Visible AND announced: a reader who cannot see
        * the muted stamp still learns that these bars are the last good ones
        * rather than the current market. */}
      {surface.kind === "degraded" ? (
        <p
          data-vex-area="spotlight-chart-degraded"
          data-reason={surface.reason}
          role="status"
          aria-live="polite"
          className="text-[12px] leading-[16px] text-warning"
        >
          {`Refresh failed. ${CHART_DEGRADED_COPY[surface.reason] ?? "The provider did not answer the latest read."} These bars are the last good read${stamp === null ? "" : `, from ${stamp}`}.`}
        </p>
      ) : null}

      <div className="relative min-w-0">
        {/* THE GLOW is a targeted underlay behind the line, not a shadow on
          * the container: a container filter would blur the grid and the axis
          * labels drawn on the same canvas. */}
        <div
          aria-hidden
          data-vex-area="spotlight-chart-glow"
          data-gradient={gradientId}
          className="pointer-events-none absolute inset-x-8 bottom-8 h-24 rounded-full bg-success opacity-[0.16] blur-2xl motion-reduce:opacity-[0.08]"
        />
        <div
          ref={containerRef}
          data-vex-area="spotlight-chart-canvas"
          tabIndex={0}
          role="img"
          aria-label={`Price chart for ${subject.baseTokenSymbol ?? subject.pairAddress} over ${PILL_LABEL[resolution]}. Use the arrow keys to read individual bars.${degraded ? " The latest refresh failed; these are the last bars that were successfully read." : ""}`}
          onKeyDown={onKeyDown}
          onBlur={() => {
            chartRef.current?.clearCrosshairPosition();
            cursorRef.current = null;
            setTooltip(null);
          }}
          className="relative h-[300px] w-full rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />

        {showSkeleton ? (
          // EXPLICIT on a resolution switch (A8): the previous pill's bars are
          // never left on screen under the new pill's label.
          <div
            data-vex-area="spotlight-chart-skeleton"
            aria-label="Loading chart"
            className="absolute inset-0 rounded-lg bg-surface-skeleton animate-pulse motion-reduce:animate-none"
          />
        ) : null}

        {showAbsence ? (
          <p
            data-vex-area="spotlight-chart-absent"
            data-reason={surface.kind === "absent" ? surface.reason : ""}
            className="absolute inset-0 flex items-center justify-center rounded-lg bg-board-card px-6 text-center text-[13px] text-ink-tertiary"
          >
            {(surface.kind === "absent"
              ? CHART_ABSENT_COPY[surface.reason]
              : undefined) ?? "These candles are unavailable."}
          </p>
        ) : null}

        {tooltip === null ? null : (
          <div
            data-vex-area="spotlight-chart-tooltip"
            data-x={Math.round(tooltip.x)}
            data-y={Math.round(tooltip.y)}
            // POINTER-EVENTS OFF and `aria-hidden`: it duplicates, for the
            // eye, what the live region below states for everyone else, and
            // it must never intercept the crosshair it is describing.
            aria-hidden
            ref={tooltipElRef}
            // NO TRANSFORM: the card's top-left corner is placed outright by
            // `placeSpotlightTooltip`, which is what lets it be clamped into
            // the pane and flipped below the crosshair near the top edge.
            className="pointer-events-none absolute left-0 top-0 z-10 rounded-lg border border-line-2 bg-surface-1 px-2.5 py-1.5 shadow-lv2"
          >
            <span className="block text-[13px] font-semibold tabular-nums text-ink-primary">
              {tooltip.priceText}
            </span>
            <span className="block text-[11.5px] tabular-nums text-ink-tertiary">
              {tooltip.timeText}
            </span>
          </div>
        )}
      </div>

      {/* THE KEYBOARD READOUT. Polite, so it does not interrupt, and updated
        * directly because `setCrosshairPosition` fires no event. */}
      <p
        data-vex-area="spotlight-chart-readout"
        role="status"
        aria-live="polite"
        className="sr-only"
      >
        {readout}
      </p>

      {/* UNCONDITIONAL, in every state: it carries the licence notice. */}
      <SpotlightChartCaption
        page={notesPage}
        hiddenOlder={normalized.hiddenOlder}
        resolution={resolution}
      />
    </figure>
  );
}

/* ------------------------------------------------------------------ */
/* Formatting helpers                                                  */
/* ------------------------------------------------------------------ */

/**
 * Re-alpha a resolved token colour for the area gradient.
 *
 * The palette bridge hands back whatever the stylesheet computed, which is an
 * `rgb()` or `rgba()` string in every browser this ships on. Anything else is
 * passed through unchanged rather than mangled: a colour we cannot parse is
 * better drawn opaque than dropped.
 */
function withAlpha(color: string, alpha: number): string {
  const match = /^rgba?\(([^)]+)\)$/i.exec(color.trim());
  if (match === null) return color;
  const parts = (match[1] ?? "").split(/[\s,/]+/).filter((part) => part !== "");
  const [r, g, b] = parts;
  if (r === undefined || g === undefined || b === undefined) return color;
  return `rgba(${r}, ${g}, ${b}, ${String(alpha)})`;
}
