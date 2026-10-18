/**
 * THE BOARD GRID - the Board page's default view (docs/design/R3-MINIMAL.md
 * section 9.4).
 *
 * Top to bottom: the meta line ("Composed by Vex in {session}" at the left,
 * the "Composed analysis · Data notes" link at the right, which opens the
 * durable authored content between the line and the grid), the filter row
 * when it can change something, the grid of EQUAL tiles drawn in quiet
 * rules, and the footnote that says where the figures come from.
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

import { useEffect, useId, useMemo, useRef, useState, type JSX } from "react";
import { useSession } from "../../../lib/api/sessions.js";
import { cn } from "../../../lib/utils.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { getSessionTitle } from "../sessionListModel.js";
import { BoardDataNotes, BoardDataNotesTrigger } from "./BoardDataNotes.js";
import { BoardGridBar } from "./BoardGridBar.js";
import { TokenCardV3 } from "./TokenCardV3.js";
import { openBoardAsk } from "./board-ask-open.js";
import {
  boardLiveReadout,
  isBoardLiveHeld,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import { useBoardSafetyVerdicts } from "./board-safety-surface.js";
import {
  boardKeyOf,
  boardSafetyVerdict,
  type BoardGridSlotProps,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";
import { formatBoardUtcClock } from "./boardFormat.js";
import {
  buildBoardAuthoredContent,
  buildBoardViewModel,
  type BoardCardModel,
} from "./boardModel.js";

/** The meta line's lead, before the source session's name. */
export const BOARD_COMPOSED_IN = "Composed by Vex in";
/** The source session's name while it is not known (still loading, or unreadable). */
const BOARD_SOURCE_FALLBACK = "this chat";

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
  const setBoardFilter = useBoardSurfaceStore((s) => s.setBoardFilter);
  const navigate = useUiStore((s) => s.navigate);

  const verdicts = useBoardSafetyVerdicts(spec);
  const sessionQuery = useSession(board.sessionId);
  const session =
    sessionQuery.data !== undefined && sessionQuery.data.ok ? sessionQuery.data.data : null;
  const sourceName = session === null ? BOARD_SOURCE_FALLBACK : getSessionTitle(session);
  const [notesOpen, setNotesOpen] = useState(false);
  const notesId = useId();
  const notesTrigger = useRef<HTMLButtonElement | null>(null);

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

  const held = isBoardLiveHeld(readout.mode);
  const clock = formatBoardUtcClock(model.marketDataFetchedAt);

  return (
    <div
      ref={scrollRef}
      data-vex-area="board-grid-scroll"
      onScroll={(event) => {
        setBoardScrollTop(event.currentTarget.scrollTop);
      }}
      className="min-h-0"
    >
      {/* THE META LINE. Where the board came from (the chat behind it, one
        * press away) and the door to the composed words. */}
      <div data-vex-area="board-meta" className="vex-bd-meta">
        <span className="vex-bd-muted">{BOARD_COMPOSED_IN}</span>
        <button
          type="button"
          data-vex-area="board-source-session"
          className="vex-bd-link"
          onClick={() => {
            navigate("chat");
          }}
        >
          {sourceName}
        </button>
        <span aria-hidden className="vex-bd-meta__sp" />
        <BoardDataNotesTrigger
          open={notesOpen}
          controls={notesId}
          triggerRef={notesTrigger}
          onToggle={() => {
            setNotesOpen((value) => !value);
          }}
        />
      </div>
      <BoardDataNotes
        content={authored}
        verdicts={verdicts}
        open={notesOpen}
        id={notesId}
        triggerRef={notesTrigger}
      />

      {/* THE FILTER ROW, labelled, and only when it can change something. */}
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
        // THE PLATE IS THE CONTAINER. `vex-board-plate` declares
        // `container-type: inline-size`, so every column threshold in
        // `global-css/board-layout.css` is a question about the width the
        // tiles actually get: an open Vex sidebar takes its width out of the
        // centre without moving the window by a pixel, which is exactly the
        // measurement a viewport media query could not see. The plate draws
        // nothing itself; the grid's quiet rules are the frame.
        className="vex-board-surface vex-board-plate"
      >
        {visible.length === 0 ? (
          <p data-vex-area="board-grid-empty" className="vex-bd-foot">
            No pool on this board matches the current filter.
          </p>
        ) : (
          /* THE SCROLLER, not the plate. Below the one-column floor the
           * track refuses to shrink and this element side-scrolls, so a
           * reader reaches a figure by scrolling instead of being shown a
           * truncated one. */
          <div
            data-vex-area="board-grid-scroller"
            className="vex-board-grid-scroller"
          >
            <ul
              data-vex-area="board-grid"
              data-count={total}
              aria-label={boardGridLabel(total, visible.length)}
              // Columns come from `board-layout.css` alone. No Tailwind
              // viewport ladder here: it was the defect.
              className="vex-board-grid"
            >
              {visible.map(({ card, index }) => (
                // `min-w-0` so a track may be narrower than its content wants,
                // and the tile itself carries `w-full`, which is what makes
                // every tile in the grid the same box.
                <li key={card.key} className={cn("flex min-w-0")}>
                  <TokenCardV3
                    card={card}
                    verdict={verdicts[index] ?? boardSafetyVerdict("pending")}
                    selected={
                      view === "spotlight" && selectedPoolIndex === index
                    }
                    live={held}
                    onSpotlight={() => {
                      openBoardSpotlight(index);
                    }}
                    onAsk={() => {
                      // Selection first, then the block, then Vex: the Ask
                      // block reads the SELECTED pool (`board-ask-open.ts`).
                      openBoardAsk(index);
                    }}
                  />
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      {/* WHERE THE FIGURES COME FROM, said once under the grid. */}
      <p data-vex-area="board-footnote" className="vex-bd-foot">
        {boardFootnote(held, clock)}
      </p>
    </div>
  );
}

/**
 * The footnote under the grid: the source and the clock of the figures (the
 * clock already carries its "UTC"), and what Ask Vex does. A snapshot names the snapshot's clock; a held lease says
 * the figures are live and when they were last read.
 */
export function boardFootnote(live: boolean, clock: string | null): string {
  const figures = live
    ? clock === null
      ? "Prices and 24h changes are live figures."
      : `Prices and 24h changes are live figures, last read at ${clock}.`
    : clock === null
      ? "Prices and 24h changes are DexScreener figures from the snapshot."
      : `Prices and 24h changes are DexScreener figures from the snapshot at ${clock}.`;
  return `${figures} Ask Vex sends a token to the chat behind this board.`;
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
