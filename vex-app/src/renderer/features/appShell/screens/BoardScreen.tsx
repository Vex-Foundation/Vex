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
 * board's close.
 */

import type { JSX } from "react";
import type { ShellScreenOrigin } from "../../../stores/uiStore.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { EmptyBlock } from "../../../components/ui/empty-block.js";
import { setBoardPageSlot } from "../Board/board-page-slot.js";
import { useBoardSurfaceStore } from "../Board/board-surface-store.js";
import { ShellScreen } from "./ShellScreen.js";

/** The page's word when no board can be bound (the old rail's copy, Vex spelt as the app spells her). */
export const BOARD_PAGE_EMPTY = "No board yet - ask Vex to compose one";
/** The next step under it: the chat is where a board is composed. */
export const BOARD_PAGE_EMPTY_ACTION = "Open the chat";

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
