/**
 * THE PILL VOCABULARY: the mockup's four windows, the bucket each reads at,
 * and the label each wears.
 *
 * One owner, because the surface, the caption and main all speak it and a
 * second copy of the label table is how a caption ends up naming a range the
 * axis is not drawing.
 */

import type { BoardChartPillResolution } from "@shared/schemas/board-chart.js";

/**
 * The mockup's four windows and the bucket each reads at.
 *
 * The buckets are the coordinator's frozen decision (1H -> 1m, 24H -> 15m,
 * 7D -> 2h, 30D -> 8h) and the bar counts they imply are main's, echoed back
 * on every answer. A pill is therefore a closed vocabulary on both sides: a
 * mistyped resolution is a compile error, not a chart that quietly polls
 * something else.
 */
export const SPOTLIGHT_PILLS: readonly {
  readonly label: string;
  readonly resolution: BoardChartPillResolution;
}[] = [
  { label: "1H", resolution: "1m" },
  { label: "24H", resolution: "15m" },
  { label: "7D", resolution: "2h" },
  { label: "30D", resolution: "8h" },
];

export const SPOTLIGHT_CHART_DEFAULT_PILL: BoardChartPillResolution = "15m";

/** What each pill is CALLED, wherever a range has to be said in words. */
export const PILL_LABEL: Readonly<Record<BoardChartPillResolution, string>> = {
  "1m": "1H",
  "15m": "24H",
  "2h": "7D",
  "8h": "30D",
};

