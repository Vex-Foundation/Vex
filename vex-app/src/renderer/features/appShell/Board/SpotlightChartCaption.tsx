/**
 * THE SPOTLIGHT CHART'S CAPTION, and the home of the licence notice.
 *
 * IT RENDERS IN EVERY STATE - pending, ready with caveats, ready with none,
 * degraded and absent - because the TradingView credit inside it is the
 * Apache-2.0 notice obligation for Lightweight Charts and the reason the
 * library's own logo widget is switched off (`attributionLogo: false`, see
 * `shared/chart-attribution.ts`). A conditional licence notice is not a
 * licence notice. The CAVEATS are the conditional part, and they are a child
 * of the caption rather than its owner.
 */

import type { JSX } from "react";
import type { BoardChartPillResolution } from "@shared/schemas/board-chart.js";
import {
  CHART_ATTRIBUTION_LABEL,
  CHART_ATTRIBUTION_URL,
} from "@shared/chart-attribution.js";
import type { SpotlightCandles } from "./spotlight-channels.js";
import { PILL_LABEL } from "./spotlightChartPills.js";

/** What the ADAPTER derived while drawing, beside what the page reported. */
export interface SpotlightChartDrawingFacts {
  /** Older bars the chart's own budget kept off screen. */
  readonly hiddenOlder: number;
  /**
   * Drawn buckets whose reported high or low did not span their own open and
   * close, so the candle shows the true extremes rather than the reported
   * pair. BLOCKING honesty: a candle DRAWS the extremes, which the area line
   * never did, so this count is now a fact about what is on screen.
   */
  readonly incoherentCount: number;
  /** Drawn buckets that carried no reported volume; their histogram slot is empty. */
  readonly volumelessCount: number;
}

export function SpotlightChartCaption({
  page,
  drawing,
  resolution,
}: {
  /** The page the bars on screen came from, degraded or fresh; null if none. */
  readonly page: SpotlightCandles | null;
  readonly drawing: SpotlightChartDrawingFacts;
  readonly resolution: BoardChartPillResolution;
}): JSX.Element {
  return (
    <figcaption
      data-vex-area="spotlight-chart-caption"
      className="flex flex-col gap-0.5 text-[12px] leading-[16px] text-ink-tertiary"
    >
      <ChartNotes page={page} drawing={drawing} resolution={resolution} />
      <ChartAttribution />
    </figcaption>
  );
}

/**
 * The notes, as a pure list: every bound the surface applied and every
 * derivation the drawing made, each with its count. Exported so the
 * vocabulary is a table test rather than a DOM scrape.
 */
export function spotlightChartNotes(
  page: SpotlightCandles,
  drawing: SpotlightChartDrawingFacts,
  resolution: BoardChartPillResolution,
): readonly string[] {
  const notes: string[] = [];
  if (page.providerBars < page.requestedBars) {
    notes.push(
      `The provider had ${String(page.providerBars)} of the ${String(page.requestedBars)} buckets this range asks for.`,
    );
  }
  if (page.undrawableBars > 0) {
    notes.push(
      `${String(page.undrawableBars)} buckets carried no USD price and are not drawn.`,
    );
  }
  if (page.windowedOutBars > 0) {
    notes.push(
      `${String(page.windowedOutBars)} older buckets sit outside this range.`,
    );
  }
  if (drawing.hiddenOlder > 0) {
    notes.push(`${String(drawing.hiddenOlder)} older bars are beyond the chart's budget.`);
  }
  if (drawing.volumelessCount > 0) {
    notes.push(
      `${String(drawing.volumelessCount)} of the ${String(page.series.bars.length)} drawn buckets carried no reported volume.`,
    );
  }
  if (drawing.incoherentCount > 0) {
    notes.push(
      `${String(drawing.incoherentCount)} buckets reported a high or low that did not span their own open and close; the chart drew the true extremes.`,
    );
  }
  if (page.series.lastBarPartial) {
    notes.push(`The newest ${PILL_LABEL[resolution]} bucket is still forming.`);
  }
  return notes;
}

/**
 * What the chart could not draw, in words.
 *
 * Every bound this surface applied is named with its count. A short provider
 * page is NOT a cut and does not say "truncated": a pool a day old genuinely
 * has three bars at the 30D pill, and calling that a truncation would blame
 * the app for the market's age.
 */
function ChartNotes({
  page,
  drawing,
  resolution,
}: {
  readonly page: SpotlightCandles | null;
  readonly drawing: SpotlightChartDrawingFacts;
  readonly resolution: BoardChartPillResolution;
}): JSX.Element | null {
  if (page === null) return null;
  const notes = spotlightChartNotes(page, drawing, resolution);
  if (notes.length === 0) return null;
  return (
    <span
      data-vex-area="spotlight-chart-notes"
      data-count={notes.length}
      className="flex flex-col gap-0.5"
    >
      {notes.map((note) => (
        <span key={note}>{note}</span>
      ))}
    </span>
  );
}

function ChartAttribution(): JSX.Element {
  return (
    <span data-vex-area="spotlight-chart-attribution" className="text-[10px] text-ink-caption">
      Charting by{" "}
      <a
        href={CHART_ATTRIBUTION_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="underline decoration-dotted underline-offset-2 hover:text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary"
      >
        {CHART_ATTRIBUTION_LABEL}
      </a>
    </span>
  );
}
