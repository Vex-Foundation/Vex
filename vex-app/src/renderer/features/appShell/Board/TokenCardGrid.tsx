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
 */

import type { JSX } from "react";
import { TokenCard } from "./TokenCard.js";
import type { BoardCardModel } from "./boardModel.js";

export interface TokenCardGridProps {
  readonly cards: readonly BoardCardModel[];
  readonly stale: boolean;
}

export function TokenCardGrid({
  cards,
  stale,
}: TokenCardGridProps): JSX.Element | null {
  if (cards.length === 0) return null;
  return (
    <ul
      data-vex-area="board-token-grid"
      data-count={cards.length}
      aria-label={`${cards.length} ${cards.length === 1 ? "pool" : "pools"} on this board`}
      className="grid grid-cols-1 gap-2 sm:grid-cols-2"
    >
      {cards.map((card) => (
        <li key={card.key} className="min-w-0">
          <TokenCard card={card} stale={stale} />
        </li>
      ))}
    </ul>
  );
}
