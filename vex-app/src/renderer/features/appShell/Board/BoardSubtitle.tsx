/**
 * THE LINE UNDER THE BOARD'S TITLE - derived, never authored.
 *
 * `board.title` above it is the MODEL's own words. This line is the RUNTIME's,
 * and it carries only facts the runtime owns: how many pools this board has
 * and the clock its figures were read at, in UTC. Nothing the model wrote can
 * reach it, which is why the two can sit one under the other without a reader
 * having to wonder which of them is a claim.
 *
 * WHY IT IS A HOST SLOT AND NOT PART OF THE GRID. It used to ride a sticky bar
 * at the top of the grid, which put a fact about the BOARD inside a view the
 * spotlight replaces, and got it into position by sticking rather than by
 * layout. As the host's subtitle slot it is beneath the title because that is
 * where the header puts it, and it is the same line in both views.
 *
 * THE CLOCK FOLLOWS THE FIGURES. The model is rebuilt from the persisted spec
 * with the live overlay drawn over it, exactly as the grid does it, so a board
 * holding a live lease dates its subtitle by the last tick rather than by the
 * moment it was composed.
 */

import { useMemo, type JSX } from "react";
import {
  boardLiveReadout,
  selectBoardLivePublication,
  useBoardLiveOverlayStore,
} from "./board-live-overlay.js";
import {
  boardKeyOf,
  type BoardSubtitleSlotProps,
} from "./board-surface-contracts.js";
import { boardSubtitle, buildBoardViewModel } from "./boardModel.js";

export function BoardSubtitle({ board }: BoardSubtitleSlotProps): JSX.Element {
  const boardKey = boardKeyOf(board);
  const publication = useBoardLiveOverlayStore((state) =>
    selectBoardLivePublication(state, boardKey),
  );
  const readout = boardLiveReadout(publication);
  const model = useMemo(
    () =>
      buildBoardViewModel(board.spec, Date.now(), {
        mode: readout.mode,
        rowsByKey: publication?.rowsByKey ?? null,
        fetchedAtMs: publication?.fetchedAtMs ?? null,
      }),
    [board.spec, readout.mode, publication],
  );

  return (
    <p
      data-vex-area="board-subtitle"
      className="mt-0.5 text-[13px] leading-[18px] text-ink-tertiary"
    >
      {boardSubtitle(model)}
    </p>
  );
}
