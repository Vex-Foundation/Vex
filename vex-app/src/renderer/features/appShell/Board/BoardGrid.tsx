/**
 * THE BOARD GRID - the modal's default view, and the mockup's own object.
 *
 * An outer rounded plate carrying a three-column grid of EQUAL cards, with
 * the durable authored content in a disclosure beneath it.
 *
 * ORDER IS MEANING. `spec.pools` IS the display order the model chose, so
 * this never sorts. The board is bounded by the spec itself (at most eight
 * pools), which is why there is no virtualization and no display cap: every
 * card the model put on the board is drawn.
 *
 * A REAL LIST, and its accessible name carries the TRUE POOL COUNT rather
 * than the filtered one. A reader who has narrowed the board to one chain is
 * told both numbers, because "1 pool" alone would misdescribe the board they
 * opened. Filtering hides cards from the eye; it must not quietly shrink what
 * the board is said to contain.
 *
 * THE GRID HOLDS NO LEASE. Live figures reach it through the overlay the
 * header's lease holder publishes, keyed by board (`board-live-overlay.ts`),
 * so there is exactly one subscription for a board no matter how many
 * surfaces are painting its figures.
 */

import { useEffect, useMemo, useRef, type JSX } from "react";
import { cn } from "../../../lib/utils.js";
import { BoardDataNotes } from "./BoardDataNotes.js";
import { BoardGridBar } from "./BoardGridBar.js";
import { TokenCardV3 } from "./TokenCardV3.js";
import {
  boardLiveReadout,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import { useBoardSafetyVerdicts } from "./board-safety-surface.js";
import {
  BOARD_SPARKLINE_PENDING,
  useBoardSparklines,
} from "./board-sparkline-source.js";
import {
  boardKeyOf,
  boardSafetyVerdict,
  type BoardGridSlotProps,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";
import {
  buildBoardAuthoredContent,
  buildBoardViewModel,
  type BoardCardModel,
} from "./boardModel.js";

export function BoardGrid({ board }: BoardGridSlotProps): JSX.Element {
  const spec = board.spec;
  const boardKey = boardKeyOf(board);

  const publication = useBoardLiveOverlayStore((state) =>
    selectBoardLivePublication(state, boardKey),
  );
  const readout = boardLiveReadout(publication);
  const filter = useBoardSurfaceStore((s) => s.filter);
  const view = useBoardSurfaceStore((s) => s.view);
  const selectedPoolIndex = useBoardSurfaceStore((s) => s.selectedPoolIndex);
  const scrollTop = useBoardSurfaceStore((s) => s.scrollTop);
  const setBoardScrollTop = useBoardSurfaceStore((s) => s.setBoardScrollTop);
  const openBoardSpotlight = useBoardSurfaceStore((s) => s.openBoardSpotlight);
  const selectBoardPool = useBoardSurfaceStore((s) => s.selectBoardPool);
  const setBoardAskOpen = useBoardSurfaceStore((s) => s.setBoardAskOpen);
  const setBoardFilter = useBoardSurfaceStore((s) => s.setBoardFilter);

  const verdicts = useBoardSafetyVerdicts(spec);
  const sparklines = useBoardSparklines(spec);

  // The model is rebuilt from the PERSISTED spec with live rows drawn over
  // it; nothing is ever written back, so turning the lease off rebuilds the
  // composed figures exactly.
  const model = useMemo(
    () =>
      buildBoardViewModel(spec, Date.now(), {
        mode: readout.mode,
        rowsByKey: publication?.rowsByKey ?? null,
        fetchedAtMs: publication?.fetchedAtMs ?? null,
      }),
    [spec, readout.mode, publication],
  );
  const authored = useMemo(() => buildBoardAuthoredContent(spec), [spec]);

  const visible = useMemo(
    () =>
      model.cards
        .map((card, index) => ({ card, index }))
        .filter(
          ({ card, index }) =>
            matchesChain(card, filter.chain) &&
            matchesSafety(verdicts[index]?.state ?? "pending", filter.safety),
        ),
    [model.cards, filter.chain, filter.safety, verdicts],
  );

  // SCROLL BELONGS TO THE BOARD, not to this mount. The store keys it by
  // board identity, so re-opening the same board restores the reader's place
  // and opening a different one starts at the top.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const restored = useRef(false);
  useEffect(() => {
    const node = scrollRef.current;
    if (node === null || restored.current) return;
    restored.current = true;
    node.scrollTop = scrollTop;
  }, [scrollTop]);

  const total = model.cards.length;
  // The filter offers only what THIS board contains, in first-appearance
  // order, so a control can never select an empty result.
  const chains = useMemo(
    () => [...new Set(model.cards.map((card) => card.chain))],
    [model.cards],
  );
  const safetyStates = useMemo(
    () => [...new Set(verdicts.map((verdict) => verdict.state))],
    [verdicts],
  );

  return (
    <div
      ref={scrollRef}
      data-vex-area="board-grid-scroll"
      onScroll={(event) => {
        setBoardScrollTop(event.currentTarget.scrollTop);
      }}
      className="min-h-0"
    >
      <BoardGridBar
        filter={filter}
        chains={chains}
        safetyStates={safetyStates}
        onFilter={setBoardFilter}
      />
      <div
        data-vex-area="board-grid-plate"
        data-count={total}
        data-visible={visible.length}
        className="vex-board-surface rounded-2xl border border-line-1 p-4"
      >
        {visible.length === 0 ? (
          <p
            data-vex-area="board-grid-empty"
            className="px-2 py-10 text-center text-[13px] text-ink-tertiary"
          >
            No pool on this board matches the current filter.
          </p>
        ) : (
          <ul
            data-vex-area="board-grid"
            data-count={total}
            aria-label={boardGridLabel(total, visible.length)}
            className="grid grid-cols-1 items-stretch gap-4 md:grid-cols-2 xl:grid-cols-3"
          >
            {visible.map(({ card, index }) => (
              <li key={card.key} className={cn("flex min-w-0")}>
                <TokenCardV3
                  card={card}
                  verdict={verdicts[index] ?? boardSafetyVerdict("pending")}
                  sparkline={sparklines[index] ?? BOARD_SPARKLINE_PENDING}
                  selected={view === "spotlight" && selectedPoolIndex === index}
                  onSpotlight={() => {
                    openBoardSpotlight(index);
                  }}
                  onAsk={() => {
                    // Selection first, then the panel: the Ask surface reads
                    // the SELECTED pool, so opening it before pointing it at
                    // this card would show the panel about another token for
                    // one commit.
                    selectBoardPool(index);
                    setBoardAskOpen(true);
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
      <BoardDataNotes content={authored} />
    </div>
  );
}

/**
 * The list's accessible name.
 *
 * Both numbers when a filter is narrowing the board, one when it is not - so
 * a reader is never told the board holds fewer pools than it does.
 */
export function boardGridLabel(total: number, visible: number): string {
  const pools = `${total} ${total === 1 ? "pool" : "pools"} on this board`;
  return visible === total ? pools : `${pools}, ${visible} shown by the filter`;
}

function matchesChain(card: BoardCardModel, chain: string | null): boolean {
  return chain === null || card.chain === chain;
}

function matchesSafety(state: string, wanted: string | null): boolean {
  return wanted === null || state === wanted;
}
