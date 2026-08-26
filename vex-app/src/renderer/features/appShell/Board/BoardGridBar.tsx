/**
 * THE FILTER ROW - the plate's first row, labelled, and only when it can
 * change something.
 *
 * WHERE IT USED TO BE. A sticky bar above the plate, right-justified and
 * unlabelled, which put "Unverified" and "High risk" floating at the top
 * right of the board where they read as two verdict chips about the board
 * rather than as a control (owner, 2026-08-26). It now sits INSIDE the plate
 * as its first row, left-aligned under a "Show" label, so a reader sees a
 * filter and its options together.
 *
 * NOT RENDERED AT ALL when no axis has two values: a single chain chip on a
 * single-chain board is a control that can only ever do nothing, and an
 * empty labelled row would be a label for nothing.
 *
 * THE FILTER IS MINIMAL ON PURPOSE: chain and safety state, the two axes a
 * reader actually narrows a board by. It is a VIEW, not a redefinition of the
 * board: the list's accessible name keeps reporting the true pool count, and
 * every filtered-out card is one keystroke from returning.
 */

import type { JSX, ReactNode } from "react";
import { cn } from "../../../lib/utils.js";
import { ChainSlugIcon } from "../../../components/common/ChainIcon.js";
import { PILL_ACTIVE_CLASS, Pill } from "../../../components/ui/pill.js";
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

/** The label the row wears. Frozen beside the row. */
export const BOARD_FILTER_LABEL = "Show";

export function BoardGridBar({
  filter,
  chains,
  safetyStates,
  onFilter,
}: BoardGridBarProps): JSX.Element | null {
  const offersChains = chains.length > 1;
  const offersSafety = safetyStates.length > 1;
  if (!offersChains && !offersSafety) return null;
  const filtered = filter.chain !== null || filter.safety !== null;
  return (
    <div
      data-vex-area="board-grid-bar"
      role="group"
      aria-label="Filter the board"
      className="flex flex-wrap items-center gap-x-2 gap-y-2"
    >
      <span
        data-vex-area="board-filter-label"
        className="vex-micro-label mr-1 uppercase text-ink-secondary"
      >
        {BOARD_FILTER_LABEL}
      </span>
      {offersChains
        ? chains.map((chain) => (
            <FilterPill
              key={`chain/${chain}`}
              area="board-filter-chain"
              label={chain}
              leading={<ChainSlugIcon chainSlug={chain} size={14} />}
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
      {offersSafety
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
  );
}

function FilterPill({
  area,
  label,
  leading,
  active,
  onToggle,
}: {
  readonly area: string;
  readonly label: string;
  readonly leading?: ReactNode;
  readonly active: boolean;
  readonly onToggle: () => void;
}): JSX.Element {
  return (
    <Pill
      variant="neutral"
      size="sm"
      data-vex-area={area}
      data-active={active ? "true" : "false"}
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active && PILL_ACTIVE_CLASS,
        active && "font-semibold",
      )}
    >
      {leading}
      <span className="min-w-0 truncate">{label}</span>
    </Pill>
  );
}
