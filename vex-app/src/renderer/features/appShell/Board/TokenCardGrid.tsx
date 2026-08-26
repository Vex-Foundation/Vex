/**
 * BOARD TOKEN GRID - the pools, in the order the agent listed them.
 *
 * Order is meaning here: the spec's `pools` array IS the display order the
 * agent chose, so the grid never sorts. It is bounded by the spec itself (at
 * most 8 pools), which is why there is no virtualization and no display cap:
 * every card the agent put on the board is drawn.
 *
 * The grid is a list to assistive tech, not a decorative arrangement, so the
 * cards sit in a real `ul`/`li` and the reader is told how many there are.
 *
 * THE CHART IS ANCHORED TO ITS CARD, and this component owns that placement.
 * A board's chart is about ONE pool (`chart.poolIndex`), and rendering it as a
 * detached footer under the whole grid left the reader to work out which card
 * it belonged to. So the owning card carries the affordance, and the panel
 * opens inside that card's own grid cell, directly beneath it.
 *
 * THE GRID MECHANIC, stated because it is the non-obvious part: the owning
 * `<li>` gains `sm:col-span-2` WHILE THE CHART IS OPEN. The cell therefore
 * widens to the full grid width and the panel below the card gets that full
 * width without ever leaving the cell. Nothing is inserted into the list, so
 * the list still has exactly one item per pool and the count in its accessible
 * name stays true - which is what an extra full-width `<li>` for the panel
 * would have broken. The cards after it reflow, which is the ordinary and
 * legible behavior of an expanding grid cell.
 */

import type { JSX, ReactNode, RefObject } from "react";
import { TokenCard } from "./TokenCard.js";
import type { BoardCardModel } from "./boardModel.js";

/** Everything the grid needs to place, and the card needs to trigger, one chart. */
export interface BoardChartSlot {
  /** Index into `cards` of the pool this chart is about. */
  readonly poolIndex: number;
  readonly open: boolean;
  /** `aria-controls` target, owned by the region its panel renders. */
  readonly regionId: string;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly onToggle: () => void;
  /** The already-built panel. The grid places it and never inspects it. */
  readonly panel: ReactNode;
}

export interface TokenCardGridProps {
  readonly cards: readonly BoardCardModel[];
  readonly stale: boolean;
  /** The board's one chart, or null when it has none. */
  readonly chart?: BoardChartSlot | null;
}

export function TokenCardGrid({
  cards,
  stale,
  chart = null,
}: TokenCardGridProps): JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <ul
      data-vex-area="board-token-grid"
      data-count={cards.length}
      aria-label={`${cards.length} ${cards.length === 1 ? "pool" : "pools"} on this board`}
      className="grid grid-cols-1 items-start gap-2.5 sm:grid-cols-2"
    >
      {cards.map((card, index) => {
        const owns = chart !== null && chart.poolIndex === index;
        return (
          <li
            key={card.key}
            data-vex-area={owns ? "board-chart-host" : undefined}
            data-chart-open={owns ? (chart.open ? "true" : "false") : undefined}
            className={
              owns && chart.open
                ? "flex min-w-0 flex-col gap-2.5 sm:col-span-2"
                : "flex min-w-0 flex-col gap-2.5"
            }
          >
            <TokenCard
              card={card}
              stale={stale}
              chart={
                owns
                  ? {
                      open: chart.open,
                      regionId: chart.regionId,
                      triggerRef: chart.triggerRef,
                      onToggle: chart.onToggle,
                    }
                  : null
              }
            />
            {owns ? chart.panel : null}
          </li>
        );
      })}
    </ul>
  );
}
