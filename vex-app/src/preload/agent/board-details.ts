import { CH } from "../../shared/ipc/channels.js";
import {
  boardDetailsPrefetchInputSchema,
  boardDetailsReadInputSchema,
  type BoardDetailsPrefetchInput,
  type BoardDetailsReadInput,
} from "../../shared/schemas/board-details.js";
import type { BoardDetailsBridge } from "../../shared/types/bridge/agent/board-details.js";
import { abortableInvoke } from "../_dispatch.js";

/**
 * vex.boardDetails.* - the board's safety, holder and lock read.
 *
 * Named domain methods only: no channel string, no `ipcRenderer`, and no way
 * for the renderer to name anything but the pool it is already displaying. The
 * input is validated HERE as well as in main, so a renderer defect is refused
 * at the boundary it belongs to rather than travelling to the privileged side
 * to be refused there.
 */
export const boardDetails = {
  /**
   * ABORTABLE for the same reason as `prefetch`: the spotlight that asked for
   * one pool's evidence can be left in the next second, and main aborts the
   * provider read on `ctx.signal` only if this side can fire it.
   */
  read(input: BoardDetailsReadInput) {
    return abortableInvoke(CH.boardDetails.read, input, boardDetailsReadInputSchema);
  },
  /**
   * ABORTABLE, and that is the whole point of the board-wide entry point.
   *
   * `prefetch` opens up to eight provider conversations on behalf of a surface
   * the reader can close in the next second. Main already aborts every one of
   * them on `ctx.signal` (`main/ipc/board-details.ts`); without a `cancel`
   * here that signal could never fire, and a closed board would go on costing
   * the provider a board's worth of reads. The renderer still cannot name a
   * timeout or a budget: it can only say "I have stopped waiting".
   */
  prefetch(input: BoardDetailsPrefetchInput) {
    return abortableInvoke(
      CH.boardDetails.prefetch,
      input,
      boardDetailsPrefetchInputSchema,
    );
  },
} satisfies BoardDetailsBridge;
