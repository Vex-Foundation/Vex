/**
 * BoardScreen: the `board` page in the centre column, both sidebars standing
 * (docs/design/R3-MINIMAL.md sections 2.3 and 9.4). Vex is hidden by default
 * here (a table page, `vexOpenPages`); the title bar names the page, keeps
 * Needs you and the token chip, and Ask Vex about a token opens in the Vex
 * sidebar.
 *
 * THE PAGE IS A PLACE, NOT AN OWNER. The board itself is rendered by the one
 * shell-level host (`Board/BoardModalHost.tsx`), which owns the binding, the
 * live lease and every exit; this page only lends it an element
 * (`Board/board-page-slot.ts`). Opening the page with nothing bound makes the
 * host bind the pinned board, else the latest one of the open session; with
 * neither, the page says so and names the next step. Leaving the page is the
 * board's close. Escape inside a spotlight returns to the grid first
 * (`useSpotlightEscapeToGrid`).
 */

import { useEffect, type JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { isDialogOnScreen } from "../../../components/ui/dialog.js";
import { setBoardPageSlot } from "../Board/board-page-slot.js";
import { useBoardSurfaceStore } from "../Board/board-surface-store.js";
import { ShellScreen } from "./ShellScreen.js";

/** The page's word when no board can be bound (the old rail's copy, Vex spelt as the app spells her). */
export const BOARD_PAGE_EMPTY = "No board yet - ask Vex to compose one";
/** The next step under it: the chat is where a board is composed. */
export const BOARD_PAGE_EMPTY_ACTION = "Open the chat";

/**
 * Escape on a spotlight steps BACK to the grid; it does not leave the page. The
 * page is the board's place and the spotlight one level inside it, so the key
 * takes one step at a time: spotlight, then grid, then (the ShellScreen's own
 * Escape) the page's close. Nothing here changes what Escape does on the grid,
 * on the empty page, or while something nearer owns the key.
 *
 * The listener is the sheet's own kind (a window keydown) and stands down for
 * the same reasons it does: a nearer owner already took the key
 * (`defaultPrevented`: the full-value panel, an open menu), or a native dialog
 * sits above the page. It takes the key BEFORE the ShellScreen's listener does
 * and says so with `preventDefault`, which the sheet's listener reads. That
 * order is the registration order: this effect is a child of the sheet's and
 * registers once (empty deps), so it is always first; the sheet's listener
 * re-registers behind it whenever its `onClose` changes.
 */
function useSpotlightEscapeToGrid(): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (isDialogOnScreen()) return;
      if (useUiStore.getState().shellRoute.kind !== "board") return;
      const surface = useBoardSurfaceStore.getState();
      if (surface.modalBoard === null || surface.view !== "spotlight") return;
      event.preventDefault();
      surface.setBoardView("grid");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
}

export function BoardScreen({
  origin,
  onClose,
}: {
  readonly origin: ShellScreenOrigin | null;
  readonly onClose: () => void;
}): JSX.Element {
  return (
    <ShellScreen title="Board" origin={origin} onClose={onClose} chapter={null}>
      <BoardPage />
    </ShellScreen>
  );
}

/** The page body: the host's element, or the empty block when nothing can be bound. */
export function BoardPage(): JSX.Element {
  useSpotlightEscapeToGrid();
  const bound = useBoardSurfaceStore((s) => s.modalBoard !== null);
  const candidate = useBoardSurfaceStore((s) => s.pinnedBoard ?? s.latestBoard);
  const activeSessionId = useUiStore((s) => s.activeSessionId);
  // Only while the route is the page: during the page's exit the board is
  // already closed, and the empty block must not flash in its place.
  const onPage = useUiStore((s) => s.shellRoute.kind === "board");
  const navigate = useUiStore((s) => s.navigate);
  // A candidate of the session in view is being bound by the host in this
  // very commit: nothing to say yet.
  const binding = candidate !== null && candidate.sessionId === activeSessionId;
  const empty = onPage && !bound && !binding;

  return (
    <div
      className="vex-bd"
      data-vex-area="board-page"
      data-state={bound ? "board" : empty ? "empty" : "binding"}
    >
      <div ref={setBoardPageSlot} data-vex-area="board-page-slot" />
      {empty ? (
        <EmptyBlock
          className="vex-bd-empty"
          data-vex-area="board-page-empty"
          scope="Board"
          title={BOARD_PAGE_EMPTY}
          action={{ label: BOARD_PAGE_EMPTY_ACTION, onClick: () => navigate("chat") }}
        />
      ) : null}
    </div>
  );
}
