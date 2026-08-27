/**
 * WHAT THE SPOTLIGHT CHART IS SHOWING, as a closed state machine.
 *
 * The surface used to derive its panels from `read.status` alone, and that
 * produced two dishonest states which A8 and A11 both name:
 *
 *  - a FAILED REFRESH covered perfectly good bars with an absence panel.
 *    A11's evidence model keeps `lastGood` and `lastAttempt` apart for
 *    exactly this reason: "unavailable" is the absence of anything useful,
 *    not the failure of the most recent attempt. Last-good bars stay on
 *    screen with an honest clock - the clock OF THOSE BARS, never the clock
 *    of the attempt that failed - and the surface says the refresh failed.
 *  - a page whose echoed resolution is not the pill on screen was treated as
 *    "ready", which is the one thing a resolution switch may never do:
 *    old bars labelled with a new pill.
 *
 * So the state is derived from the page that is OF THE PILL ON SCREEN, plus
 * the channel's own `lastGood` - which is the OWNER of that fact, kept there
 * across consecutive failures, and fenced here by the same `forResolution`
 * echo so a last-good page can never be drawn under a different pill either.
 * Every panel the component renders is a branch of the union below and
 * nothing else, which is what
 * makes "bars and an absence panel at the same time" unrepresentable rather
 * than merely unlikely.
 */

import type { BoardChartPillResolution } from "@shared/schemas/board-chart.js";
import type { SpotlightCandles, SpotlightRead } from "./spotlight-channels.js";

export type SpotlightChartSurfaceState =
  /** Nothing of this pill to draw yet, and the read has not given up. */
  | { readonly kind: "skeleton" }
  /** A page of the pill on screen. */
  | { readonly kind: "ready"; readonly page: SpotlightCandles; readonly fetchedAtMs: number }
  /** The refresh failed; these bars and this clock are the last good ones. */
  | {
      readonly kind: "degraded";
      readonly page: SpotlightCandles;
      readonly fetchedAtMs: number;
      readonly reason: string;
    }
  /** Asked, learned nothing, and nothing good to fall back on. */
  | { readonly kind: "absent"; readonly reason: string };

/**
 * The page this read holds FOR THIS PILL, or null.
 *
 * `forResolution` is main's echo. The channel's accept fence already keeps a
 * mismatched answer out of state; this keeps a matched-but-stale RENDER out
 * of the surface, which is a different window (see `SpotlightCandles`).
 */
export function spotlightChartPageOf(
  read: SpotlightRead<SpotlightCandles>,
  resolution: BoardChartPillResolution,
): SpotlightCandles | null {
  if (read.status !== "ready") return null;
  return read.value.forResolution === resolution ? read.value : null;
}

export function spotlightChartSurfaceState(args: {
  readonly read: SpotlightRead<SpotlightCandles>;
  readonly resolution: BoardChartPillResolution;
}): SpotlightChartSurfaceState {
  const { read, resolution } = args;
  const page = spotlightChartPageOf(read, resolution);
  if (page !== null) {
    return { kind: "ready", page, fetchedAtMs: page.fetchedAtMs };
  }
  if (read.status === "unavailable") {
    const lastGood = read.lastGood;
    if (lastGood === null || lastGood.value.forResolution !== resolution) {
      // A CANCELLATION WITH NOTHING BEHIND IT IS NOT AN ABSENCE. "Cancelled"
      // says the read was cut, not that the market has nothing; the channel
      // re-issues it, so the honest picture is "still waiting". A cancelled
      // refresh over last-good bars is still the degraded arm below.
      if (read.reason === "cancelled") return { kind: "skeleton" };
      return { kind: "absent", reason: read.reason };
    }
    return {
      kind: "degraded",
      page: lastGood.value,
      fetchedAtMs: lastGood.fetchedAtMs,
      reason: read.reason,
    };
  }
  return { kind: "skeleton" };
}
