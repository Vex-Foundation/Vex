/**
 * ACTIVE BOARD - the BOOK's Board tab (product spec item 4).
 *
 * The rail's standing answer to "what is on the board right now": the model's
 * own title, when its figures were read, whether they are live, the top three
 * tokens as compact rows, the token the spotlight is showing when one is, and
 * two doors - Open board and Ask VEX.
 *
 * PINNED WINS. A reader who pinned a board asked for THAT board to stay in
 * the rail. A newer one composed since does not replace it; it lights the
 * unseen dot on the tab and waits to be chosen (A1/A3). With nothing pinned,
 * the latest board is what the module shows.
 *
 * THE MODULE NEVER OPENS THE MODAL BY ITSELF, and it never switches the tab.
 * Both are reader actions. What it does do is CLEAR the unseen dot: reaching
 * this module with the unseen board actually visible in it is the reader
 * having seen it (A13 clear path a). The other clear path - that board's
 * modal opening from anywhere - belongs to the store.
 *
 * THE MODULE HOLDS NO LEASE. Live figures reach it through the overlay the
 * modal's lease holder publishes; with no modal open there is no lease, and
 * the module honestly shows the composed snapshot and says so.
 *
 * A PROJECT RAIL HAS NO BOARD, BY CONSTRUCTION (Studio parity decree,
 * 2026-09-04). A board is composed by VEX inside an Agent chat transcript and
 * carries that session's identity (`BoardRef.sessionId`); a project has no
 * transcript. So under the `project` scope the module renders an honest
 * empty state and reads NOTHING from the board store: a board retained there
 * belongs to a session, and showing it under a project's name would be
 * another entity's state. The one action offered is the way to where boards
 * are composed - switching the shell to Agent mode.
 */

import { useEffect, useMemo, type JSX } from "react";
import { cn } from "../../../../lib/utils.js";
import { useUiStore } from "../../../../stores/uiStore.js";
import type { BookRailScopeKind } from "../section-order.js";
import { ActiveBoardRow } from "./ActiveBoardRow.js";
import {
  boardLiveReadout,
  isBoardLiveHeld,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "../../Board/board-live-overlay.js";
import {
  boardKeyOf,
  type BoardRef,
} from "../../Board/board-surface-contracts.js";
import { useBoardSurfaceStore } from "../../Board/board-surface-store.js";
import { formatBoardUtcClock } from "../../Board/boardFormat.js";
import { buildBoardViewModel } from "../../Board/boardModel.js";

/** How many token rows the rail shows. The rest are counted, not drawn. */
const ROW_COUNT = 3;

/**
 * The four states the rail can honestly be in about its figures, and the word
 * for each.
 *
 * ONE WORD PER FACT. `LIVE` is reserved for `live-connected`, the only mode in
 * which a tick has actually landed. `Connecting` and `Reconnecting` are
 * BoardBlock's own words for the same two modes (`BoardBlock.tsx`, LiveBadge),
 * so the tab, the block and the preview card never describe one socket three
 * different ways.
 */
const LIVE_STATE_LABEL = {
  snapshot: "Snapshot",
  connecting: "Connecting",
  reconnecting: "Reconnecting",
  live: "LIVE",
} as const;

/** What the module says when this session has composed no board yet. */
export const ACTIVE_BOARD_EMPTY = "No board yet - ask VEX to compose one";

/** What the module says on a PROJECT rail, which can never hold a board. */
export const PROJECT_BOARD_EMPTY =
  "A board is a token radar VEX composes for you inside an Agent chat. A project has no chat, so there is no board here - open an Agent session to ask for one.";

/**
 * Where keyboard focus goes when `Switch to Agent` unmounts under the user.
 *
 * The button lives in the Studio shell, and the mode write it makes replaces
 * that shell with the Agent one in the same commit; focus left on a removed
 * node drops the user to `document.body`, outside every surface. The
 * DOCUMENTED DESTINATION is the runtime-mode capsule (`RuntimeModeToggle`,
 * `role="radiogroup"` named "Runtime mode"), the one control both shells mount
 * for the same decision: its checked segment is the roving tab stop, it now
 * reads "Agent", and the way back to Studio is one arrow key from it. Found by
 * its accessible name and role rather than a ref, because the destination is
 * another feature's control in a subtree this module never owns.
 *
 * A microtask, and not an effect, because this module is gone after the
 * commit: the click is a React event, so React flushes the mode switch before
 * the microtask runs (the same reasoning as `TerminalTabs`' rename field). If
 * the Agent shell mounted no capsule (a collapsed Agent rail over an active
 * session seats none), there is nothing to hand focus to and the microtask
 * leaves it alone rather than guessing at a control this module cannot name.
 */
const RUNTIME_MODE_CHECKED_SEGMENT_SELECTOR =
  '[role="radiogroup"][aria-label="Runtime mode"] [role="radio"][aria-checked="true"]';

function handFocusToRuntimeModeControl(): void {
  queueMicrotask(() => {
    const segment = document.querySelector(RUNTIME_MODE_CHECKED_SEGMENT_SELECTOR);
    if (segment instanceof HTMLElement) segment.focus();
  });
}

export function ActiveBoardModule({
  scopeKind,
}: {
  /** The rail's scope kind. `project` renders the honest empty state. */
  readonly scopeKind: BookRailScopeKind;
}): JSX.Element {
  const pinnedBoard = useBoardSurfaceStore((s) => s.pinnedBoard);
  const latestBoard = useBoardSurfaceStore((s) => s.latestBoard);
  const setRuntimeMode = useUiStore((s) => s.setRuntimeMode);

  if (scopeKind === "project") {
    return (
      <section
        data-vex-area="active-board"
        data-state="empty"
        data-scope="project"
        aria-label="Active board"
        className="flex flex-col gap-2.5 rounded-xl border border-line-2 bg-surface-1 px-3 py-3"
      >
        <p
          data-vex-area="active-board-empty"
          className="text-[12.5px] leading-[17px] text-ink-tertiary"
        >
          {PROJECT_BOARD_EMPTY}
        </p>
        {/* Not an authority change: `runtimeMode` only decides which surfaces
          * mount (the same write the approval row and the Studio keybinding
          * make). The session shown there is whichever the agent shell last
          * had; this module names none. The write unmounts this button, so
          * focus is handed on deliberately (rule 08: focus after unmount). */}
        <button
          type="button"
          data-vex-area="active-board-switch-agent"
          onClick={() => {
            setRuntimeMode("agent");
            handFocusToRuntimeModeControl();
          }}
          className="inline-flex items-center justify-center self-start rounded-lg border border-line-2 px-2.5 py-1.5 text-[12.5px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          Switch to Agent
        </button>
      </section>
    );
  }

  // Pinned wins for the module; the dot is how a newer board announces itself.
  const board = pinnedBoard ?? latestBoard;

  if (board === null) {
    return (
      <section
        data-vex-area="active-board"
        data-state="empty"
        aria-label="Active board"
        className="rounded-xl border border-line-2 bg-surface-1 px-3 py-3"
      >
        <p
          data-vex-area="active-board-empty"
          className="text-[12.5px] leading-[17px] text-ink-tertiary"
        >
          {ACTIVE_BOARD_EMPTY}
        </p>
      </section>
    );
  }
  // Keyed by identity so switching boards rebuilds the module's state rather
  // than carrying one board's clock into another's.
  return <ActiveBoard key={boardKeyOf(board)} board={board} />;
}

function ActiveBoard({ board }: { readonly board: BoardRef }): JSX.Element {
  const boardKey = boardKeyOf(board);
  const spec = board.spec;

  const unseenBoardKey = useBoardSurfaceStore((s) => s.unseenBoardKey);
  const acknowledgeBoardSeen = useBoardSurfaceStore((s) => s.acknowledgeBoardSeen);
  const openBoardModal = useBoardSurfaceStore((s) => s.openBoardModal);
  const openBoardSpotlight = useBoardSurfaceStore((s) => s.openBoardSpotlight);
  const setBoardAskOpen = useBoardSurfaceStore((s) => s.setBoardAskOpen);
  const modalBoard = useBoardSurfaceStore((s) => s.modalBoard);
  const view = useBoardSurfaceStore((s) => s.view);
  const selectedPoolIndex = useBoardSurfaceStore((s) => s.selectedPoolIndex);

  // A13 clear path (a): this module is mounted (so the Board tab is the
  // selected one) with THIS board visible in it. Key-guarded in the store, so
  // a dot for a different board is left alone.
  useEffect(() => {
    if (unseenBoardKey !== boardKey) return;
    acknowledgeBoardSeen(boardKey);
  }, [unseenBoardKey, boardKey, acknowledgeBoardSeen]);

  const publication = useBoardLiveOverlayStore((state) =>
    selectBoardLivePublication(state, boardKey),
  );
  const readout = boardLiveReadout(publication);
  const model = useMemo(
    () =>
      buildBoardViewModel(spec, Date.now(), {
        mode: readout.mode,
        rowsByKey: publication?.rowsByKey ?? null,
        fetchedAtMs: publication?.fetchedAtMs ?? null,
      }),
    [spec, readout.mode, publication],
  );

  // HOLDING A LEASE IS NOT A LANDED TICK, and the rail used to say it was:
  // one `held` boolean painted the green LIVE pill for `live-connecting` and
  // `live-degraded` alike, so a board that had asked for a socket and a board
  // whose socket had dropped both read as figures arriving right now. `held`
  // still decides whether this is the LIVE PATH at all (snapshot versus not,
  // which is what `data-live` has always meant); `mode` decides what is said.
  // The vocabulary is BoardBlock's and BoardPreviewCard's, deliberately: three
  // surfaces inventing three words for the same socket state is three chances
  // for the reader to be told different things about the same second.
  const held = isBoardLiveHeld(model.mode);
  const connected = model.mode === "live-connected";
  const liveState = !held
    ? "snapshot"
    : connected
      ? "live"
      : model.mode === "live-degraded"
        ? "reconnecting"
        : "connecting";
  const liveLabel = LIVE_STATE_LABEL[liveState];
  const clock = formatBoardUtcClock(model.marketDataFetchedAt);
  const rows = model.cards.slice(0, ROW_COUNT);
  const overflow = model.cards.length - rows.length;
  // The spotlight row is shown only while THIS board's spotlight is actually
  // up: a remembered selection behind a closed modal is not "the active
  // token", and saying it was would be a claim about a surface nobody is
  // looking at.
  const spotlightIndex =
    modalBoard !== null && boardKeyOf(modalBoard) === boardKey && view === "spotlight"
      ? selectedPoolIndex
      : null;
  const spotlightCard =
    spotlightIndex === null ? null : (model.cards[spotlightIndex] ?? null);

  return (
    <section
      data-vex-area="active-board"
      data-state="board"
      data-live={held ? "true" : "false"}
      data-live-state={liveState}
      aria-label={`Active board: ${board.title}`}
      className="flex flex-col gap-2.5 rounded-xl border border-line-2 bg-surface-1 px-3 py-3"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {/* The MODEL's own title. The rail prints no product label over it. */}
          <p
            data-vex-area="active-board-title"
            className="truncate font-display text-[13.5px] font-bold leading-[18px] tracking-[-0.01em] text-ink-primary"
            title={board.title}
          >
            {board.title}
          </p>
          <p
            data-vex-area="active-board-clock"
            className="truncate text-[11.5px] leading-[15px] text-ink-tertiary"
          >
            {clock === null ? "clock unavailable" : `Updated ${clock}`}
          </p>
        </div>
        <span
          data-vex-area="active-board-mode"
          data-mode={liveState}
          data-live-mode={model.mode}
          className={cn(
            "flex shrink-0 items-center gap-1 whitespace-nowrap text-[11px] font-semibold leading-[15px]",
            connected ? "text-success" : held ? "text-warning-label" : "text-ink-tertiary",
          )}
        >
          {/* The dot pulses ONLY for a lease that is actually delivering
            * ticks. A pulse on a connecting or dropped socket would be motion
            * standing in for an event that has not happened. The WORD beside
            * it carries the whole meaning on its own. */}
          <span
            aria-hidden
            className={cn(
              "h-[5px] w-[5px] rounded-full",
              connected
                ? "bg-success motion-safe:animate-pulse"
                : held
                  ? "bg-warning"
                  : "bg-ink-dimmed",
            )}
          />
          {liveLabel}
        </span>
      </div>

      {/* The live state is a fact about the figures beside it, so it is
        * SPOKEN as well as painted: the dot is unavailable to a reader on
        * assistive tech, and whether prices are updating changes what they
        * mean. */}
      <p aria-live="polite" className="sr-only" data-vex-area="active-board-live-region">
        {liveState === "live"
          ? `${board.title}: live figures`
          : liveState === "connecting"
            ? `${board.title}: connecting to live figures, still showing figures${clock === null ? "" : ` read at ${clock}`}`
            : liveState === "reconnecting"
              ? `${board.title}: reconnecting, figures may be behind${clock === null ? "" : `, last read at ${clock}`}`
              : `${board.title}: snapshot figures${clock === null ? "" : ` read at ${clock}`}`}
      </p>

      <ul data-vex-area="active-board-rows" className="flex flex-col gap-1">
        {rows.map((card, index) => (
          <li key={card.key} className="flex">
            <ActiveBoardRow
              card={card}
              active={spotlightIndex === index}
              onOpen={() => {
                // Bind the modal first, then point it at this token: the
                // spotlight reads the SELECTED pool of the BOUND board.
                openBoardModal(board);
                openBoardSpotlight(index);
              }}
            />
          </li>
        ))}
      </ul>
      {overflow > 0 ? (
        <p
          data-vex-area="active-board-overflow"
          className="text-[11.5px] leading-[15px] text-ink-tertiary"
        >
          {`+${String(overflow)} more on the board`}
        </p>
      ) : null}

      {spotlightCard !== null ? (
        <div data-vex-area="active-board-spotlight" className="flex flex-col gap-1">
          <p className="vex-micro-label uppercase text-ink-secondary">Spotlight</p>
          <ActiveBoardRow
            card={spotlightCard}
            active
            onOpen={() => {
              openBoardModal(board);
              if (spotlightIndex !== null) openBoardSpotlight(spotlightIndex);
            }}
          />
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <button
          type="button"
          data-vex-area="active-board-open"
          onClick={() => {
            openBoardModal(board);
          }}
          className="inline-flex flex-1 items-center justify-center rounded-lg bg-button-accent px-2.5 py-1.5 text-[12.5px] font-semibold text-ink-on-button-accent transition-colors duration-150 hover:bg-button-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          Open board
        </button>
        <button
          type="button"
          data-vex-area="active-board-ask"
          onClick={() => {
            // The Ask panel lives INSIDE the modal, so asking from the rail
            // opens the board and the panel together.
            openBoardModal(board);
            setBoardAskOpen(true);
          }}
          className="inline-flex flex-1 items-center justify-center rounded-lg border border-line-2 px-2.5 py-1.5 text-[12.5px] font-medium text-ink-secondary transition-colors duration-150 hover:border-line-3 hover:bg-interactive-hover hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
        >
          Ask VEX
        </button>
      </div>
    </section>
  );
}
