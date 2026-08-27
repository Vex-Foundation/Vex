/**
 * THE TRANSCRIPT ROW'S BOARD - the container that turns a persisted spec into
 * a board the surfaces know about.
 *
 * WHY A CONTAINER AT ALL, when `BoardPreviewCard` is presentation and its
 * props are frozen. The transcript row holds two things: its own `row.board`
 * document and its message id. Everything else the card needs - the session
 * it belongs to, the store's open action, and what the live lease is doing -
 * is ambient. Resolving that here keeps the change site in
 * `TranscriptMessage.tsx` a single line and keeps `BoardPreviewCard` free of
 * store reads, which is what lets it be rendered from a test with three
 * plain props.
 *
 * A HISTORICAL ROW RENDERS FROM ITS OWN DOCUMENT (A1). The store owns
 * selection and ephemeral state, never board documents, so a card five
 * thousand messages back paints from the spec beside it rather than from
 * whatever board happens to be latest.
 *
 * THE UNSEEN DOT IS FAIL-CLOSED, and deliberately not lit here yet. Only a
 * real live append may light it, and `boardArrivalOf` needs the transcript's
 * own `SettledIdsTracker` - which reaches `TranscriptRows` but not this deep.
 * So `arrival` is an OPTIONAL prop defaulting to `"settled"`: a board
 * recorded as history, which never lights a dot. Threading the tracker is the
 * one change the sidebar's owner needs to make, and until it does the
 * behaviour is the conservative one rather than a guess.
 */

import { useEffect, useMemo, type JSX } from "react";
import type { BoardSpecV1 } from "@vex-lib/board/index.js";
import { useUiStore } from "../../../stores/uiStore.js";
import { BoardPreviewCard } from "./BoardPreviewCard.js";
import {
  boardLiveReadout,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  boardKeyOf,
  boardRefOf,
  type BoardArrival,
} from "./board-surface-contracts.js";
import { useBoardSurfaceStore } from "./board-surface-store.js";

export interface BoardRowCardProps {
  readonly messageId: number;
  readonly spec: BoardSpecV1;
  /** How this row reached the screen. Only `"live-append"` may light a dot. */
  readonly arrival?: BoardArrival | undefined;
}

export function BoardRowCard({
  messageId,
  spec,
  arrival = "settled",
}: BoardRowCardProps): JSX.Element | null {
  const sessionId = useUiStore((s) => s.activeSessionId);
  const openBoardModal = useBoardSurfaceStore((s) => s.openBoardModal);
  const noteBoardRow = useBoardSurfaceStore((s) => s.noteBoardRow);

  const board = useMemo(
    () => (sessionId === null ? null : boardRefOf(sessionId, messageId, spec)),
    [sessionId, messageId, spec],
  );

  // Records this board as a candidate for `latestBoard`. Idempotent by the
  // store's own key comparison, so a re-render of a virtualised row costs
  // nothing and cannot re-light anything.
  useEffect(() => {
    if (board === null) return;
    noteBoardRow(board, arrival);
  }, [board, arrival, noteBoardRow]);

  const boardKey = board === null ? null : boardKeyOf(board);
  const publication = useBoardLiveOverlayStore((state) =>
    boardKey === null ? null : selectBoardLivePublication(state, boardKey),
  );

  // No session means no board identity, and a board with no identity has no
  // modal to open. Nothing is rendered rather than a card that cannot act.
  if (board === null) return null;

  return (
    <BoardPreviewCard
      board={board}
      onOpen={openBoardModal}
      live={boardLiveReadout(publication)}
    />
  );
}
