/**
 * BOARD HOST - the one board surface in the application, presented as the
 * Board PAGE (docs/design/R3-MINIMAL.md section 9.4).
 *
 * MOUNTED ONCE, at shell level, never per transcript row, and never by the
 * page. A board card in the transcript does not own a surface; it asks the
 * store to bind this host to a board. Two consequences the per-row
 * alternative could not give us: a board stays bound while the reader
 * scrolls its originating message out of the virtualised transcript, and
 * there is exactly one place where "a board is open" is true. The name keeps
 * its history (it used to present a dialog); the lifecycle below is what it
 * is for.
 *
 * THE PAGE IS A PLACE, THE HOST IS THE OWNER. The page
 * (`screens/BoardScreen.tsx`, route `board`) provides the element this host
 * renders into (`board-page-slot.ts`); the Ask Vex block renders into the Vex
 * sidebar's slot (`features/vex/vex-sidebar-slot.ts`). The host stays the
 * one owner of the binding, the exits and the keyed slots, so moving from a
 * dialog to a page moved where the pixels go and nothing about who holds the
 * live lease.
 *
 * THE PAGE AND THE BINDING MOVE TOGETHER, in three rules:
 *  - binding a board opens its page (a transcript card's Open board);
 *  - on the page with nothing bound, the page binds the pinned board, else
 *    the latest one of the open session, through the store's own open path
 *    (the Board nav); with neither, the page says so;
 *  - leaving the page is the close: `closeBoardModal`, the ONE close path,
 *    cuts every registered feed and bumps both generations BEFORE the state
 *    clears. A session switch and shell teardown reach the same action.
 *
 * THE UNMOUNT DISCIPLINE. Nothing is rendered while no board is bound, so a
 * closed board keeps no chart subscribed and no tape polling.
 *
 * SLOTS. The host owns the frame, the head row and the lifecycle; it renders
 * NOTHING about tokens. The grid, the spotlight, the subtitle, the head
 * controls and the Ask Vex block arrive as typed component props, so the
 * builders that write them never edit this file.
 *
 * THE SUBTITLE IS THE HOST'S PLACE, NOT THE GRID'S. It is the one line the
 * design puts beside the model's title, and it states facts the FRAME owns:
 * how many pools this board has and the clock its figures were read at. It
 * is the same line in both views.
 */

import { useEffect, useRef, type JSX } from "react";
import { createPortal } from "react-dom";
import { useUiStore } from "../../../stores/uiStore.js";
import { useVexSidebarSlot } from "../../vex/vex-sidebar-slot.js";
import { useBoardPageSlot } from "./board-page-slot.js";
import { boardKeyOf } from "./board-surface-contracts.js";
import type {
  BoardAskSlotProps,
  BoardGridSlotProps,
  BoardHeaderSlotProps,
  BoardSpotlightSlotProps,
  BoardSubtitleSlotProps,
  BoardSurfaceSlot,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";

export interface BoardModalHostProps {
  readonly headerSlot?: BoardSurfaceSlot<BoardHeaderSlotProps>;
  /** The derived line beside the model's title. Optional like every slot. */
  readonly subtitleSlot?: BoardSurfaceSlot<BoardSubtitleSlotProps>;
  readonly gridSlot?: BoardSurfaceSlot<BoardGridSlotProps>;
  readonly spotlightSlot?: BoardSurfaceSlot<BoardSpotlightSlotProps>;
  readonly askSlot?: BoardSurfaceSlot<BoardAskSlotProps>;
}

export function BoardModalHost({
  headerSlot: HeaderSlot,
  subtitleSlot: SubtitleSlot,
  gridSlot: GridSlot,
  spotlightSlot: SpotlightSlot,
  askSlot: AskSlot,
}: BoardModalHostProps): JSX.Element | null {
  const board = useBoardSurfaceStore((s) => s.modalBoard);
  const pinnedBoard = useBoardSurfaceStore((s) => s.pinnedBoard);
  const latestBoard = useBoardSurfaceStore((s) => s.latestBoard);
  const view = useBoardSurfaceStore((s) => s.view);
  const selectedPoolIndex = useBoardSurfaceStore((s) => s.selectedPoolIndex);
  const askPanelOpen = useBoardSurfaceStore((s) => s.askPanelOpen);
  const openBoardModal = useBoardSurfaceStore((s) => s.openBoardModal);
  const closeBoardModal = useBoardSurfaceStore((s) => s.closeBoardModal);
  const exitBoardSurfaces = useBoardSurfaceStore((s) => s.exitBoardSurfaces);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  const routeKind = useUiStore((s) => s.shellRoute.kind);
  const setShellRoute = useUiStore((s) => s.setShellRoute);
  const pageSlot = useBoardPageSlot();
  const sidebarSlot = useVexSidebarSlot();

  // EXPLICIT EXIT TRANSITIONS. Switching session and going home are not
  // "the surface happens to unmount": they are transitions that must cut
  // every registered feed first. The host owns them because it is the one
  // component that lives exactly as long as the shell does.
  const previousSessionId = useRef(activeSessionId);
  useEffect(() => {
    if (previousSessionId.current === activeSessionId) return;
    previousSessionId.current = activeSessionId;
    exitBoardSurfaces({
      reason: activeSessionId === null ? "home" : "session-switch",
      keepSessionId: activeSessionId,
    });
  }, [activeSessionId, exitBoardSurfaces]);

  // Shell teardown. Registered at mount, so a crash-unmount cuts feeds too.
  useEffect(
    () => () => {
      exitBoardSurfaces({ reason: "app-shell-exit", keepSessionId: null });
    },
    [exitBoardSurfaces],
  );

  /**
   * THE IDENTITY EVERY SLOT IS KEYED BY.
   *
   * Rebinding board A to board B does not unmount this host, and React reuses
   * a child of the same type at the same position: without a key the head
   * controls, the grid and the spotlight all survive the change of subject
   * with board A's state still in them. That is not a theoretical hazard -
   * the head controls hold the live lease and publish rows to the overlay
   * under whatever `boardKey` they are currently given, so a retained row
   * from A was being published under B's key.
   *
   * Keying is the structural fix rather than a guard each slot has to
   * remember: a new board is a new component instance, so there is no
   * retained state for a slot to leak, and every slot's own unmount cleanup
   * runs before the replacement mounts.
   */
  const boardKey = board === null ? null : boardKeyOf(board);

  // BINDING A BOARD OPENS ITS PAGE. Declared BEFORE the close rule below and
  // it writes the route synchronously, so in the commit that binds a board
  // from the bare shell the close rule already reads the page as open.
  useEffect(() => {
    if (boardKey === null) return;
    if (useUiStore.getState().shellRoute.kind === "board") return;
    setShellRoute({ kind: "board", origin: null });
  }, [boardKey, setShellRoute]);

  // LEAVING THE PAGE IS THE CLOSE. The route is read live, not from this
  // render: the rule above may have opened the page a moment ago.
  useEffect(() => {
    if (boardKey === null) return;
    if (useUiStore.getState().shellRoute.kind === "board") return;
    closeBoardModal();
  }, [routeKind, boardKey, closeBoardModal]);

  // THE PAGE BINDS A BOARD: the pinned one, else the latest of the open
  // session (a newer board never silently replaces a pinned one). Only a
  // board of the session in view: the store forgets the others on a switch,
  // and this guard says so here too.
  const candidate = pinnedBoard ?? latestBoard;
  useEffect(() => {
    if (routeKind !== "board" || boardKey !== null || candidate === null) return;
    if (candidate.sessionId !== activeSessionId) return;
    openBoardModal(candidate);
  }, [routeKind, boardKey, candidate, activeSessionId, openBoardModal]);

  // The spec is the bound: a stored selection cannot address a pool that this
  // board does not have (a pinned selection outliving a shorter board).
  // Lower bound last, so a board with NO pools clamps to 0 rather than to the
  // -1 an upper-bound-first clamp would produce.
  const poolIndex =
    board === null
      ? 0
      : Math.max(Math.min(selectedPoolIndex, board.spec.pools.length - 1), 0);

  if (board === null || pageSlot === null) return null;

  const body = (
    <div data-vex-surface="board-page" data-view={view}>
      <header className="vex-bd-head" data-vex-area="board-header">
        {/* The heading is the MODEL's own title for this board. The host
         * never prints a product label of its own over it; the title bar
         * names the page. */}
        <div className="vex-bd-head__title">
          <h2 data-vex-area="board-title" className="vex-bd-head__name">
            {board.title}
          </h2>
          {SubtitleSlot === undefined ? null : <SubtitleSlot board={board} />}
        </div>
        {HeaderSlot === undefined ? null : (
          <HeaderSlot key={boardKey} board={board} />
        )}
      </header>

      <div data-vex-area="board-body" data-view={view}>
        {view === "spotlight"
          ? SpotlightSlot === undefined
            ? null
            : (
                /* The spotlight's subject is the POOL, not the board:
                 * selecting a different token on the same board is the same
                 * change of subject, and A8 forbids the previous token's
                 * figures being on screen under the new one's name for even
                 * one commit. */
                <SpotlightSlot
                  key={`${String(boardKey)}:${String(poolIndex)}`}
                  board={board}
                  poolIndex={poolIndex}
                />
              )
          : GridSlot === undefined
            ? null
            : <GridSlot key={boardKey} board={board} />}
      </div>
    </div>
  );

  return (
    <>
      {createPortal(body, pageSlot)}
      {/* ASK VEX LIVES IN VEX'S COLUMN. Only while the sidebar is open (a
       * hidden sidebar has no slot) and only while the page is up. */}
      {askPanelOpen && AskSlot !== undefined && sidebarSlot !== null
        ? createPortal(
            <AskSlot key={boardKey} board={board} poolIndex={poolIndex} />,
            sidebarSlot,
          )
        : null}
    </>
  );
}
