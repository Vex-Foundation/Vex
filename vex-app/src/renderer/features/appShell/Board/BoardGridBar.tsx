/**
 * THE FILTER BAR AT THE TOP OF THE GRID (A2).
 *
 * THE SUBTITLE USED TO LIVE HERE AND NO LONGER DOES. It is a fact about the
 * BOARD, not about the grid view, so it moved to the host's `subtitleSlot`
 * (`BoardSubtitle.tsx`), where it sits directly under the model's title by
 * layout rather than by stickiness and stays put when the spotlight replaces
 * this view. What remains here is the control that genuinely belongs to the
 * grid: nothing else filters cards.
 *
 * THE BAR IS STILL STICKY, because the control it carries is one a reader
 * reaches for while scrolled into a long board.
 *
 * THE FILTER IS MINIMAL ON PURPOSE: chain and safety state, the two axes a
 * reader actually narrows a board by. It is a VIEW, not a redefinition of the
 * board: the list's accessible name keeps reporting the true pool count, and
 * every filtered-out card is one keystroke from returning.
 */

import type { JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { Pill } from "../../../components/ui/pill.js";
import {
  BOARD_SAFETY_CHIP,
  type BoardSafetyState,
} from "./board-surface-contracts.js";
import { BOARD_FILTER_NONE, type BoardFilter } from "./board-surface-store.js";

export interface BoardGridBarProps {
  readonly filter: BoardFilter;
  /** Chains present on THIS board, in first-appearance order. */
  readonly chains: readonly string[];
  /** Safety states present on THIS board, in first-appearance order. */
  readonly safetyStates: readonly BoardSafetyState[];
  readonly onFilter: (filter: BoardFilter) => void;
}

export function BoardGridBar({
  filter,
  chains,
  safetyStates,
  onFilter,
}: BoardGridBarProps): JSX.Element {
  const filtered = filter.chain !== null || filter.safety !== null;
  return (
    <div
      data-vex-area="board-grid-bar"
      className="sticky top-0 z-10 -mt-1 flex flex-wrap items-center justify-end gap-x-4 gap-y-2 bg-surface-1 pb-3 pt-1"
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {/* Only offered when there is something to choose BETWEEN. A single
          * chain chip on a single-chain board is a control that can only ever
          * do nothing. */}
        {chains.length > 1
          ? chains.map((chain) => (
              <FilterPill
                key={`chain/${chain}`}
                area="board-filter-chain"
                label={chain}
                active={filter.chain === chain}
                onToggle={() => {
                  onFilter({
                    ...filter,
                    chain: filter.chain === chain ? null : chain,
                  });
                }}
              />
            ))
          : null}
        {safetyStates.length > 1
          ? safetyStates.map((state) => (
              <FilterPill
                key={`safety/${state}`}
                area="board-filter-safety"
                label={BOARD_SAFETY_CHIP[state].label}
                active={filter.safety === state}
                onToggle={() => {
                  onFilter({
                    ...filter,
                    safety: filter.safety === state ? null : state,
                  });
                }}
              />
            ))
          : null}
        {filtered ? (
          <FilterPill
            area="board-filter-clear"
            label="Clear"
            active={false}
            onToggle={() => {
              onFilter(BOARD_FILTER_NONE);
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

function FilterPill({
  area,
  label,
  active,
  onToggle,
}: {
  readonly area: string;
  readonly label: string;
  readonly active: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <Pill
      variant={active ? "accent" : "neutral"}
      size="sm"
      data-vex-area={area}
      data-active={active ? "true" : "false"}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && "font-semibold",
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
    </Pill>
  );
}
