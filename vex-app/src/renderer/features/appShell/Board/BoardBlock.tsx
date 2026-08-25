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

  const model = useMemo(() => buildBoardViewModel(spec, now), [spec, now]);
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
      className="flex flex-col gap-3 rounded-xl border border-line-2 bg-surface-2 p-3"
    >
      <header className="flex flex-col gap-0.5">
        <h3 className="font-display text-[14px] font-extrabold leading-tight tracking-[-0.02em] text-ink-primary">
          {model.title}
        </h3>
        <BoardClocks
          analysisCreatedAt={model.analysisCreatedAt}
          marketDataFetchedAt={model.marketDataFetchedAt}
          stale={model.stale}
        />
      </header>

      <TokenCardGrid cards={model.cards} stale={model.stale} />

      <BoardNotes notes={model.notes} />

      {chart !== null && chartPool !== null && candles !== null ? (
        <div className="flex flex-col gap-2">
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={chartOpen}
            aria-controls={regionId}
            onClick={() => setChartOpen((open) => !open)}
            className="vex-micro-label self-start rounded-md px-1.5 py-1 uppercase text-ink-secondary hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            {chartOpen ? "Hide chart" : "Show chart"}
          </button>
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
            />
          </ExpandRegion>
        </div>
      ) : null}
    </section>
  );
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
  stale,
}: {
  readonly analysisCreatedAt: number;
  readonly marketDataFetchedAt: number;
  readonly stale: boolean;
}): JSX.Element {
  const analysis = formatBoardClock(analysisCreatedAt);
  const market = formatBoardClock(marketDataFetchedAt);
  return (
    <p
      data-vex-area="board-clocks"
      className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-tertiary"
    >
      {analysis !== null ? <span>Analysis {analysis}</span> : null}
      {market !== null ? <span>Market data {market}</span> : null}
      {stale ? (
        <span data-vex-area="board-stale-note" className="text-warning-label">
          Snapshot, not live.
        </span>
      ) : null}
    </p>
  );
}
