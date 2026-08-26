/**
 * THE SPOTLIGHT, WIRED TO ITS CHART.
 *
 * One line of composition, in its own file for one reason: `SpotlightChart`
 * imports the slot's prop TYPE from `BoardSpotlight`, and binding the two
 * inside either of them would make the pair mutually dependent for the sake
 * of a default. The shell mounts THIS as the host's `spotlightSlot`, and the
 * surface stays testable without a canvas.
 */

import type { JSX } from "react";
import { BoardSpotlight } from "./BoardSpotlight.js";
import { SpotlightChart } from "./SpotlightChart.js";
import type { BoardSpotlightSlotProps } from "./board-surface-contracts.js";

export function BoardSpotlightWithChart(props: BoardSpotlightSlotProps): JSX.Element {
  return <BoardSpotlight {...props} chartSlot={SpotlightChart} />;
}
