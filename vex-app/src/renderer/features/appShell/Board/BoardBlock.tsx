/**
 * BOARD BLOCK - the transcript's entry point for a persisted board.
 *
 * The board is a SNAPSHOT the agent composed: its figures were fetched once,
 * at compose time, and nothing here refetches them. That honesty is the whole
 * design of this surface - the header carries both clocks (when the analysis
 * was written, when its market data was read) and every card says "delayed"
 * once the data has outlived its freshness window.
 *
 * The chart sits behind a disclosure, and the disclosure state does real work
 * rather than merely hiding pixels: `BoardChart` only creates its
 * lightweight-charts instance while the region is open, because a chart
 * created into a collapsed, zero-height container loses every
 * viewport-preservation guarantee the library has and jumps the moment the
 * region opens. Collapsing runs the chart's cleanup, which detaches the
 * primitives and releases the ResizeObserver and the pending frame.
 *
 * This file interprets nothing itself: `boardModel.ts` owns the spec-to-view
 * mapping and the components below own presentation.
 */

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import type { BoardSpecV1 } from "@vex-lib/board/index.js";
import { useBoardLive, type BoardDataMode } from "../../../lib/api/board-live.js";
import { cn } from "../../../lib/utils.js";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import { BoardChart } from "./BoardChart.js";
import { BoardNotes } from "./BoardNotes.js";
import { TokenCardGrid } from "./TokenCardGrid.js";
import { boardChartSubjectKey } from "./boardChartFeed.js";
import { formatBoardClock } from "./boardFormat.js";
import {
  boardAriaLabel,
  buildAnnotationRows,
  buildBoardViewModel,
} from "./boardModel.js";

export interface BoardBlockProps {
  readonly spec: BoardSpecV1;
}

export function BoardBlock({ spec }: BoardBlockProps): JSX.Element {
  const regionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [chartOpen, setChartOpen] = useState(false);

  // THE FRESHNESS CLOCK, and why it is one timeout rather than a tick.
  //
  // A board is a snapshot, so a second-by-second countdown would imply this
  // surface tracks something live. But reading `Date.now()` once per mount was
  // wrong in the other direction: a board appended to an open chat mounts
  // FRESH and, with the chat left open, never gains "Snapshot, not live" no
  // matter how old its market data gets.
  //
  // There is exactly one moment at which anything on this surface changes:
  // `marketDataFetchedAt + staleAfterMs`. So this effect owns ONE timeout
  // aimed at that boundary, clears it on unmount and re-aims it whenever the
  // spec's own clock moves (a refresh rewrites `marketDataFetchedAt`). A board
  // already past the boundary schedules nothing at all: it is stale forever.
  const [now, setNow] = useState(() => Date.now());
  const staleAt = spec.hydration.marketDataFetchedAt + spec.hydration.staleAfterMs;
  useEffect(() => {
    const remainingMs = staleAt - Date.now();
    if (remainingMs <= 0) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), remainingMs);
    return () => clearTimeout(timer);
  }, [staleAt]);

  // THE LEASE. Default OFF on every mount and never persisted: a board is a
  // document, and a document that reconnected to a market feed by itself would
  // spend a reader's provider budget without being asked. The pools identity is
  // memoized because it is the hook's stability contract, not a convenience.
  const livePools = useMemo(
    () =>
      spec.pools.map((pool) => ({
        chain: pool.chain,
        pairAddress: pool.pairAddress,
      })),
    [spec],
  );
  const live = useBoardLive(livePools);

  const model = useMemo(
    () =>
      buildBoardViewModel(spec, now, {
        mode: live.mode,
        rowsByKey: live.rowsByKey,
        fetchedAtMs: live.fetchedAtMs,
      }),
    [spec, now, live.mode, live.rowsByKey, live.fetchedAtMs],
  );
  const annotationRows = useMemo(() => buildAnnotationRows(spec), [spec]);
  const unmatchedMarkers = useMemo(
    () => new Set(spec.hydration.unmatchedMarkerAtMs ?? []),
    [spec],
  );

  const chart = spec.chart ?? null;
  const candles = spec.hydration.candles ?? null;
  const chartPool = chart === null ? null : (spec.pools[chart.poolIndex] ?? null);

  return (
    <section
      data-vex-area="board-block"
      data-stale={model.stale ? "true" : "false"}
      aria-label={boardAriaLabel(model)}
      className="flex flex-col gap-3.5 rounded-xl border border-line-2 bg-surface-2 p-3.5"
    >
      {/* The header owns the board's identity and its two clocks, and the
        * hairline below it separates the agent's framing from the market
        * figures that follow. The title is the display voice one step up from
        * a card's heading, so a board reads as a composed object rather than as
        * a run of cards that happen to sit together. */}
      <header className="flex flex-col gap-1.5 border-b border-line-2 pb-3">
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
          <h3 className="min-w-0 font-display text-[16px] font-extrabold leading-tight tracking-[-0.02em] text-ink-primary">
            {model.title}
          </h3>
          <div className="flex shrink-0 items-center gap-2">
            {/* The honest badge, kept in these exact words. It appears only
              * once the data has actually outlived its window AND nothing is
              * refreshing it - a lease that is connected or reconnecting is
              * already making the opposite statement one element to the right,
              * and showing both at once would say two things about the same
              * figures. It is a statement, never decoration. */}
            {model.stale && !isLiveHeld(live.mode) ? (
              <span
                data-vex-area="board-stale-note"
                className="vex-micro-label rounded-md border border-line-2 bg-surface-1 px-1.5 py-0.5 uppercase text-warning-label"
              >
                Snapshot, not live.
              </span>
            ) : null}
            <LiveBadge mode={live.mode} />
            <LiveToggle
              mode={live.mode}
              canToggle={live.canToggle}
              onToggle={live.toggle}
            />
          </div>
        </div>
        <BoardClocks
          analysisCreatedAt={model.analysisCreatedAt}
          marketDataFetchedAt={model.marketDataFetchedAt}
        />
      </header>

      <TokenCardGrid
        cards={model.cards}
        stale={model.stale}
        chart={
          chart !== null && chartPool !== null && candles !== null
            ? {
                poolIndex: chart.poolIndex,
                open: chartOpen,
                regionId,
                triggerRef,
                onToggle: () => setChartOpen((open) => !open),
                panel: renderChart(),
              }
            : null
        }
      />

      {live.notice === null ? null : (
        <p
          data-vex-area="board-live-notice"
          role="status"
          className="text-[11px] text-ink-tertiary"
        >
          {live.notice}
        </p>
      )}

      <BoardNotes notes={model.notes} />
    </section>
  );

  /**
   * The chart panel, built here and handed to the grid to PLACE.
   *
   * The split is deliberate: this component owns the disclosure state and
   * everything the chart needs from the spec, while the grid owns where a
   * full-width panel lands relative to the card that claims it. Neither knows
   * the other's job, and `BoardChart` stays mount-agnostic - it is told whether
   * its region is open and nothing about where it sits.
   */
  function renderChart(): JSX.Element | null {
    if (chart === null || chartPool === null || candles === null) return null;
    return (
      <ExpandRegion id={regionId} open={chartOpen} triggerRef={triggerRef}>
            <BoardChart
              subjectKey={boardChartSubjectKey(
                chartPool.chain,
                chartPool.pairAddress,
                chart.resolution,
              )}
              open={chartOpen}
              resolution={chart.resolution}
              bars={candles.bars}
              levels={(chart.annotations ?? []).flatMap((annotation, index) =>
                annotation.kind === "level"
                  ? [{ key: `level/${index}`, price: annotation.price }]
                  : [],
              )}
              zones={(chart.annotations ?? []).flatMap((annotation, index) =>
                annotation.kind === "zone"
                  ? [
                      {
                        key: `zone/${index}`,
                        priceFrom: annotation.priceFrom,
                        priceTo: annotation.priceTo,
                      },
                    ]
                  : [],
              )}
              // Only markers whose instant matched a hydrated candle EXACTLY
              // reach the canvas. The rest keep their label and their instant
              // in the legend below, with the reason they are not drawn - the
              // library would otherwise snap them onto a neighbouring bar.
              markers={(chart.annotations ?? []).flatMap((annotation, index) =>
                annotation.kind === "marker"
                  && !unmatchedMarkers.has(annotation.atMs)
                  ? [{ key: `marker/${index}`, atMs: annotation.atMs }]
                  : [],
              )}
              annotationRows={annotationRows}
              label={`Price chart for ${chartPool.chain} pair ${chartPool.pairAddress} at ${chart.resolution}${
                model.stale ? ", market data delayed" : ""
              }`}
              lastBarPartial={candles.lastBarPartial}
              truncated={candles.truncated}
              // The hydration's own provenance sentence. The board has always
              // persisted it and no surface had ever rendered it; the chart's
              // data-notes disclosure is where it belongs, beside the other
              // statements about what these bytes are.
              provenance={spec.hydration.provenance}
              // The PERSISTED clock, deliberately, and not `model`'s. While a
              // lease is live the cards move and this chart does not, so it
              // carries the clock of the candles that are actually drawn.
              fetchedAtMs={spec.hydration.marketDataFetchedAt}
        />
      </ExpandRegion>
    );
  }
}

/**
 * The two clocks, kept distinct on purpose. The analysis clock is immutable -
 * it dates the agent's reasoning. The market-data clock moves when the
 * figures are refreshed. Collapsing them into one "updated" line would let a
 * refresh silently re-date the analysis.
 */
function BoardClocks({
  analysisCreatedAt,
  marketDataFetchedAt,
}: {
  readonly analysisCreatedAt: number;
  readonly marketDataFetchedAt: number;
}): JSX.Element {
  const analysis = formatBoardClock(analysisCreatedAt);
  const market = formatBoardClock(marketDataFetchedAt);
  return (
    <p
      data-vex-area="board-clocks"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-tertiary"
    >
      {analysis !== null ? (
        <span className="tabular-nums">
          <span className="vex-micro-label uppercase text-ink-secondary">
            Analysis
          </span>{" "}
          {analysis}
        </span>
      ) : null}
      {market !== null ? (
        <span className="tabular-nums">
          <span className="vex-micro-label uppercase text-ink-secondary">
            Market data
          </span>{" "}
          {market}
        </span>
      ) : null}
    </p>
  );
}

/** Whether the reader currently holds a lease, in either of its two live states. */
function isLiveHeld(mode: BoardDataMode): boolean {
  return (
    mode === "live-connecting" ||
    mode === "live-connected" ||
    mode === "live-degraded"
  );
}

/**
 * The LIVE control.
 *
 * A REAL BUTTON with `aria-pressed`, so it is in the tab order, Enter and Space
 * operate it with no key handler of our own, and its state reaches assistive
 * tech as state rather than as a colour. The accessible name states the ACTION,
 * which is what a reader needs from a control they have not yet pressed.
 *
 * DISABLED, NOT HIDDEN, when the build cannot reach the market channel. Hiding
 * it would mean a reader never learns the capability exists; a control that
 * looks live and fails on its first click is worse still. So capability is
 * asked BEFORE this renders, and an unsupported build gets a disabled control
 * whose title says why.
 */
function LiveToggle({
  mode,
  canToggle,
  onToggle,
}: {
  readonly mode: BoardDataMode;
  readonly canToggle: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  const held = isLiveHeld(mode);
  const unsupported = mode === "live-unsupported";
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={held}
      aria-label={held ? "Stop live figures" : "Show live figures"}
      disabled={!canToggle && !held}
      data-vex-area="board-live-toggle"
      title={
        unsupported
          ? "Live figures need the DexScreener site channel, which this build does not mount."
          : undefined
      }
      className={cn(
        "vex-micro-label rounded-md border px-2 py-1 uppercase transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary motion-reduce:transition-none",
        held
          ? "border-line-1 bg-interactive-hover text-ink-primary"
          : "border-line-2 text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary",
        !canToggle && !held && "cursor-not-allowed opacity-50",
      )}
    >
      Live
    </button>
  );
}

/**
 * What the lease is doing, in words plus one dot.
 *
 * The dot pulses ONLY while a lease is actually delivering ticks, and the
 * animation is the honest one: this is the single surface in the board that has
 * earned motion, because something really is arriving. `motion-reduce` stills
 * it for a reader who asked for that, and the WORD beside it carries the whole
 * meaning on its own - the dot never says anything the text does not.
 */
function LiveBadge({ mode }: { readonly mode: BoardDataMode }): JSX.Element | null {
  if (mode === "snapshot" || mode === "live-off" || mode === "live-unsupported") {
    return null;
  }
  const connected = mode === "live-connected";
  return (
    <span
      data-vex-area="board-live-badge"
      data-live-mode={mode}
      className={cn(
        "vex-micro-label flex items-center gap-1.5 rounded-md border border-line-2 bg-surface-1 px-1.5 py-0.5 uppercase",
        connected ? "text-success" : "text-warning-label",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "h-[5px] w-[5px] rounded-full",
          connected
            ? "animate-pulse bg-success motion-reduce:animate-none"
            : "bg-warning",
        )}
      />
      {connected ? "Live" : mode === "live-degraded" ? "Reconnecting" : "Connecting"}
    </span>
  );
}
