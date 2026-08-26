/**
 * BOARD MODAL HOST - the one board modal in the application.
 *
 * MOUNTED ONCE, at shell level, never per transcript row. A board card in the
 * transcript does not own a dialog; it asks the store to bind this host to a
 * board. Two consequences the per-row alternative could not give us: a board
 * stays open while the reader scrolls its originating message out of the
 * virtualised transcript, and there is exactly one place where "the modal is
 * open" is true.
 *
 * THE UNMOUNT DISCIPLINE. A native `<dialog>` that closes does NOT unmount its
 * children: without the conditional below, a closed board would keep a chart
 * subscribed and a tape polling, invisibly. So the body renders its children
 * only while a board is bound, while the `<dialog>` element itself stays
 * mounted so `DialogContent`'s close listener can still restore focus to
 * whatever opened it.
 *
 * ONE CLOSE PATH. The X, Esc (native `cancel`), a backdrop click, a session
 * switch and shell teardown all reach `closeBoardModal`, which cuts every
 * registered feed and bumps both generations BEFORE the state clears. There is
 * no second way to close this dialog.
 *
 * SLOTS. The host owns the frame, the header chrome, the accessible name and
 * the lifecycle; it renders NOTHING about tokens. The grid, the spotlight, the
 * subtitle, the header controls and the Ask VEX panel arrive as typed
 * component props, so the builders that write them never edit this file.
 *
 * THE SUBTITLE IS THE HOST'S PLACE, NOT THE GRID'S. It is the one line the
 * design puts directly beneath the model's title, and it states facts the
 * FRAME owns - how many pools this board has and the clock its figures were
 * read at. Carrying it inside the grid meant it lived in a view the spotlight
 * replaces, and reached its position through a sticky bar rather than through
 * the layout. Here it is beneath the title because that is where the header
 * puts it.
 */

import { useEffect, useRef, type JSX } from "react";
import { useUiStore } from "../../../stores/uiStore.js";
import { IconClose } from "../../../components/icons/index.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogClose,
  DialogHeadlessHeader,
} from "../../../components/ui/dialog.js";
import type {
  BoardAskSlotProps,
  BoardGridSlotProps,
  BoardHeaderSlotProps,
  BoardSpotlightSlotProps,
  BoardSubtitleSlotProps,
  BoardSurfaceSlot,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";

const BOARD_DIALOG_DESCRIPTION =
  "Market figures for the tokens on this board. Press Escape to close.";

export interface BoardModalHostProps {
  readonly headerSlot?: BoardSurfaceSlot<BoardHeaderSlotProps>;
  /** The derived line under the model's title. Optional like every slot. */
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
}: BoardModalHostProps): JSX.Element {
  const board = useBoardSurfaceStore((s) => s.modalBoard);
  const view = useBoardSurfaceStore((s) => s.view);
  const selectedPoolIndex = useBoardSurfaceStore((s) => s.selectedPoolIndex);
  const askPanelOpen = useBoardSurfaceStore((s) => s.askPanelOpen);
  const closeBoardModal = useBoardSurfaceStore((s) => s.closeBoardModal);
  const exitBoardSurfaces = useBoardSurfaceStore((s) => s.exitBoardSurfaces);
  const activeSessionId = useUiStore((s) => s.activeSessionId);

  // EXPLICIT EXIT TRANSITIONS. Switching session and going home are not
  // "the modal happens to unmount": they are transitions that must cut every
  // registered feed first. The host owns them because it is the one component
  // that lives exactly as long as the shell does.
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

  const open = board !== null;
  // The spec is the bound: a stored selection cannot address a pool that this
  // board does not have (a pinned selection outliving a shorter board).
  // Lower bound last, so a board with NO pools clamps to 0 rather than to the
  // -1 an upper-bound-first clamp would produce.
  const poolIndex =
    board === null
      ? 0
      : Math.max(Math.min(selectedPoolIndex, board.spec.pools.length - 1), 0);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeBoardModal();
      }}
    >
      <DialogContent
        size="board"
        className="vex-board-dialog"
        data-vex-surface="board-modal"
      >
        {/* The visible header is ours below; the screen reader still gets a
         * real title and description carrying the dialog's context ids. */}
        <DialogHeadlessHeader
          title={board === null ? "Board" : board.title}
          description={BOARD_DIALOG_DESCRIPTION}
        />
        {board === null ? null : (
          <>
            <header
              className="flex shrink-0 items-start justify-between gap-4 px-6 pt-6 pb-4"
              data-vex-area="board-header"
            >
              {/* The heading is the MODEL's own title for this board. The
               * host never prints a product label of its own over it. */}
              <div className="min-w-0">
                <p className="text-[20px] font-medium leading-7 text-ink-primary">
                  {board.title}
                </p>
                {SubtitleSlot === undefined ? null : (
                  <SubtitleSlot board={board} />
                )}
              </div>
              <div className="flex shrink-0 items-center gap-3">
                {HeaderSlot === undefined ? null : <HeaderSlot board={board} />}
                <DialogClose
                  aria-label="Close the board"
                  className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-tertiary hover:bg-interactive-active hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <IconClose size={16} />
                </DialogClose>
              </div>
            </header>

            <DialogBody
              className="flex-row gap-0 px-0 py-0"
              data-vex-area="board-body"
            >
              <div
                className="min-w-0 flex-1 overflow-y-auto px-6 pb-6"
                data-vex-area={
                  view === "spotlight" ? "board-spotlight" : "board-grid"
                }
              >
                {view === "spotlight"
                  ? SpotlightSlot === undefined
                    ? null
                    : <SpotlightSlot board={board} poolIndex={poolIndex} />
                  : GridSlot === undefined
                    ? null
                    : <GridSlot board={board} />}
              </div>
              {askPanelOpen && AskSlot !== undefined ? (
                <aside
                  className="w-[360px] shrink-0 overflow-y-auto border-l border-line-1 px-5 pb-6"
                  data-vex-area="board-ask"
                >
                  <AskSlot board={board} poolIndex={poolIndex} />
                </aside>
              ) : null}
            </DialogBody>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
