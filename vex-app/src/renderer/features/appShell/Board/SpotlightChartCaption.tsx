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

export function SpotlightChartCaption({
  page,
  hiddenOlder,
  resolution,
}: {
  /** The page the bars on screen came from, degraded or fresh; null if none. */
  readonly page: SpotlightCandles | null;
  readonly hiddenOlder: number;
  readonly resolution: BoardChartPillResolution;
}): JSX.Element {
  return (
    <figcaption
      data-vex-area="spotlight-chart-caption"
      className="flex flex-col gap-0.5 text-[11.5px] leading-[15px] text-ink-tertiary"
    >
      <ChartNotes page={page} hiddenOlder={hiddenOlder} resolution={resolution} />
      <ChartAttribution />
    </figcaption>
  );
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
  hiddenOlder,
  resolution,
}: {
  /** The page the bars on screen came from, degraded or fresh; null if none. */
  readonly page: SpotlightCandles | null;
  readonly hiddenOlder: number;
  readonly resolution: BoardChartPillResolution;
}): JSX.Element | null {
  if (page === null) return null;
  const value = page;
  const notes: string[] = [];
  if (value.providerBars < value.requestedBars) {
    notes.push(
      `The provider had ${String(value.providerBars)} of the ${String(value.requestedBars)} buckets this range asks for.`,
    );
  }
  if (value.undrawableBars > 0) {
    notes.push(
      `${String(value.undrawableBars)} buckets carried no USD price and are not drawn.`,
    );
  }
  if (value.windowedOutBars > 0) {
    notes.push(
      `${String(value.windowedOutBars)} older buckets sit outside this range.`,
    );
  }
  if (hiddenOlder > 0) {
    notes.push(`${String(hiddenOlder)} older bars are beyond the chart's budget.`);
  }
  if (value.series.lastBarPartial) {
    notes.push(`The newest ${PILL_LABEL[resolution]} bucket is still forming.`);
  }
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
