import { CH } from "../../shared/ipc/channels.js";
import {
  boardMomentumInputSchema,
  boardOtherPoolsInputSchema,
  boardSpotlightContextInputSchema,
  boardTapePollInputSchema,
  boardTopTradersInputSchema,
  type BoardMomentumInput,
  type BoardOtherPoolsInput,
  type BoardSpotlightContextInput,
  type BoardTapePollInput,
  type BoardTopTradersInput,
} from "../../shared/schemas/board-spotlight.js";
import type { BoardSpotlightBridge } from "../../shared/types/bridge/agent/board-spotlight.js";
import { abortableInvoke } from "../_dispatch.js";

/**
 * vex.boardSpotlight.* - the spotlight's own per-pool reads.
 *
 * Named domain methods only: no channel string, no `ipcRenderer`, and no way
 * for the renderer to name anything but the pool it is already displaying.
 * Inputs are validated HERE as well as in main, so a renderer defect is
 * refused at the boundary it belongs to.
 *
 * EVERY METHOD IS ABORTABLE. Each of these five reads is owned by a surface
 * the reader can leave in the next second, and main already aborts the
 * provider read on `ctx.signal`; that signal can only fire if this side can
 * fire it. Without `cancel`, leaving the spotlight would stop the renderer
 * LISTENING while five provider conversations ran on to their deadlines. The
 * renderer still cannot name a timeout, a budget or a cadence: `cancel` says
 * only "I have stopped waiting".
 */
export const boardSpotlight = {
  topTraders(input: BoardTopTradersInput) {
    return abortableInvoke(
      CH.boardSpotlight.topTraders,
      input,
      boardTopTradersInputSchema,
    );
  },
  momentum(input: BoardMomentumInput) {
    return abortableInvoke(
      CH.boardSpotlight.momentum,
      input,
      boardMomentumInputSchema,
    );
  },
  otherPools(input: BoardOtherPoolsInput) {
    return abortableInvoke(
      CH.boardSpotlight.otherPools,
      input,
      boardOtherPoolsInputSchema,
    );
  },
  context(input: BoardSpotlightContextInput) {
    return abortableInvoke(
      CH.boardSpotlight.context,
      input,
      boardSpotlightContextInputSchema,
    );
  },
  tapePoll(input: BoardTapePollInput) {
    return abortableInvoke(
      CH.boardSpotlight.tapePoll,
      input,
      boardTapePollInputSchema,
    );
  },
} satisfies BoardSpotlightBridge;
