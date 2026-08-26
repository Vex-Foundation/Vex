/**
 * CHART CAVEATS - what the chart is NOT showing, in two registers.
 *
 * THE COMPOSITION DECISION. These sentences used to be the chart's headline:
 * a wrapped run of diagnostic prose ("8 bars with open or close outside the
 * reported high/low", "newest bar still forming") sitting directly under the
 * canvas, in the position a caption occupies, with nothing separating a
 * routine fact from a serious one. The information was right and its
 * presentation was wrong - a reader scanning the board met a paragraph of
 * qualifications before they met the chart.
 *
 * So the surface splits by REGISTER, not by importance:
 *
 *  - the STATUS LINE is always visible and always short: the resolution and
 *    the bar count, the two facts that describe what the chart IS.
 *  - the DATA NOTES region holds the full sentences that describe what the
 *    chart is NOT, plus the hydration's own provenance observation.
 *
 * NOTHING IS CUT AND NOTHING IS DELETED (owner decree on silent content
 * cutting). Every sentence that used to be on screen is still reachable
 * whole, one keystroke away, with a trigger that states how many notes there
 * are so the reader knows something is there before opening it. Relocating a
 * disclosure is allowed; shortening one is not.
 *
 * ACCESSIBILITY. The trigger is a real `<button>` inside the chart's own
 * `<figcaption>`, so it is in the tab order and Enter and Space operate it
 * without a key handler of our own. `ExpandRegion` owns the rest of the
 * contract: a closed region is `aria-hidden` and `inert`, so its sentences
 * leave both the accessibility tree and the tab order, and focus returns to
 * the trigger before the region closes. A hover-only tooltip would have put
 * these sentences out of reach of a keyboard entirely.
 */

import { useId, useRef, useState, type JSX } from "react";
import { ExpandRegion } from "../../../components/ui/expand-region.js";
import { BOARD_CHART_MAX_BARS } from "./boardChartFeed.js";
import { formatBoardClock } from "./boardFormat.js";
import type { BoardChartResolution } from "@vex-lib/board/index.js";

/** Where the hydration bytes came from, as the spec records it. */
export interface BoardChartProvenance {
  readonly transport: string;
  readonly sourceObservation: string;
}

export interface ChartCaveatsProps {
  readonly resolution: BoardChartResolution;
  readonly drawn: number;
  readonly hiddenOlder: number;
  readonly whitespaceCount: number;
  readonly incoherentCount: number;
  readonly lastBarPartial: boolean;
  readonly truncated: boolean;
  /**
   * The spec's own `hydration.provenance`, or null when the caller has none.
   * It is a disclosure channel the board has always persisted and no surface
   * has ever rendered, which is why it belongs here rather than nowhere.
   */
  readonly provenance: BoardChartProvenance | null;
  /**
   * When these candles were read, as an epoch, or null when unusable.
   *
   * ALWAYS the clock the board was COMPOSED with, even while the cards above
   * are live. The board's live lease refreshes card metrics only: there is no
   * push channel for candles and the chart feed can append and update bars but
   * cannot retract them, so a live candle stream without a reconciliation
   * contract would leave bars on screen that the toggle could not take back.
   * The chart is therefore an honest snapshot and SAYS SO with its own clock,
   * rather than inheriting a freshness it does not have from the cards beside
   * it. Live candles are a declared future gate whose named prerequisite is
   * that reconciliation contract.
   */
  readonly fetchedAtMs: number | null;
}

/** One data note: a stable key and the WHOLE sentence. */
interface DataNote {
  readonly key: string;
  readonly text: string;
}

/**
 * Every note this chart owes its reader, in the order a reader needs them:
 * what is missing from the drawing first, what the drawing derived second,
 * where the bytes came from last.
 */
export function buildChartDataNotes({
  hiddenOlder,
  whitespaceCount,
  incoherentCount,
  lastBarPartial,
  truncated,
  provenance,
}: Omit<
  ChartCaveatsProps,
  // The clock is a fact about the drawing, not a data NOTE: it belongs to the
  // always-visible line and never inside the disclosure.
  "resolution" | "drawn" | "fetchedAtMs"
>): readonly DataNote[] {
  const notes: DataNote[] = [];
  if (hiddenOlder > 0) {
    notes.push({
      key: "hidden-older",
      text: `${hiddenOlder} older ${hiddenOlder === 1 ? "bar exists" : "bars exist"} beyond the ${BOARD_CHART_MAX_BARS}-bar display window and are not drawn.`,
    });
  }
  if (whitespaceCount > 0) {
    notes.push({
      key: "whitespace",
      text: `${whitespaceCount} ${whitespaceCount === 1 ? "bucket" : "buckets"} reported no price. Each holds its slot on the time axis and draws no candle; a gap is never filled with a zero.`,
    });
  }
  if (incoherentCount > 0) {
    notes.push({
      key: "incoherent",
      text: `${incoherentCount} ${incoherentCount === 1 ? "bar has" : "bars have"} an open or close outside the high and low the provider reported for the same bar. Those wicks span all four reported values, so the drawn extreme is derived here rather than reported.`,
    });
  }
  if (lastBarPartial) {
    notes.push({
      key: "forming",
      text: "The newest bar is still forming, so its close is the price at the moment of the read, not the bar's final close.",
    });
  }
  if (truncated) {
    notes.push({
      key: "truncated",
      text: "The provider bounded the range it returned, so history older than the first bar exists but was not sent.",
    });
  }
  if (provenance !== null) {
    notes.push({
      key: "provenance",
      text: `Read over ${provenance.transport}. ${provenance.sourceObservation}`,
    });
  }
  return notes;
}

export function ChartCaveats({
  resolution,
  drawn,
  hiddenOlder,
  whitespaceCount,
  incoherentCount,
  lastBarPartial,
  truncated,
  provenance,
  fetchedAtMs,
}: ChartCaveatsProps): JSX.Element {
  const regionId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const chartClock = fetchedAtMs === null ? null : formatBoardClock(fetchedAtMs);
  const notes = buildChartDataNotes({
    hiddenOlder,
    whitespaceCount,
    incoherentCount,
    lastBarPartial,
    truncated,
    provenance,
  });

  return (
    <figcaption
      data-vex-area="board-chart-caveats"
      className="flex flex-col gap-1"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-ink-tertiary">
        <span
          data-vex-area="board-chart-resolution"
          className="vex-micro-label rounded-md border border-line-2 px-1.5 py-0.5 uppercase text-ink-secondary"
        >
          {resolution}
        </span>
        <span className="tabular-nums">
          {drawn} {drawn === 1 ? "bar" : "bars"}
        </span>
        {chartClock === null ? null : (
          <span data-vex-area="board-chart-asof" className="tabular-nums">
            chart as of {chartClock}
          </span>
        )}
        {notes.length > 0 ? (
          <button
            ref={triggerRef}
            type="button"
            aria-expanded={open}
            aria-controls={regionId}
            onClick={() => setOpen((current) => !current)}
            data-vex-area="board-chart-notes-trigger"
            className="vex-micro-label rounded-md px-1.5 py-0.5 uppercase text-ink-secondary hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
          >
            Data notes ({notes.length})
          </button>
        ) : null}
      </div>
      <ExpandRegion id={regionId} open={open} triggerRef={triggerRef}>
        <ul
          data-vex-area="board-chart-notes"
          className="flex flex-col gap-1 rounded-lg border border-line-2 bg-surface-1 p-2 text-[11px] leading-relaxed text-ink-tertiary"
        >
          {notes.map((note) => (
            <li key={note.key} data-note-kind={note.key}>
              {note.text}
            </li>
          ))}
        </ul>
      </ExpandRegion>
    </figcaption>
  );
}
