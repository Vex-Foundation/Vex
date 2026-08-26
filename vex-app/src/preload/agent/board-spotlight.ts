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
import { invokeWithSchema } from "../_dispatch.js";

/**
 * vex.boardSpotlight.* - the spotlight's own per-pool reads.
 *
 * Named domain methods only: no channel string, no `ipcRenderer`, and no way
 * for the renderer to name anything but the pool it is already displaying.
 * Inputs are validated HERE as well as in main, so a renderer defect is
 * refused at the boundary it belongs to.
 */
export const boardSpotlight = {
  topTraders(input: BoardTopTradersInput) {
    return invokeWithSchema(
      CH.boardSpotlight.topTraders,
      input,
      boardTopTradersInputSchema,
    );
  },
  momentum(input: BoardMomentumInput) {
    return invokeWithSchema(
      CH.boardSpotlight.momentum,
      input,
      boardMomentumInputSchema,
    );
  },
  otherPools(input: BoardOtherPoolsInput) {
    return invokeWithSchema(
      CH.boardSpotlight.otherPools,
      input,
      boardOtherPoolsInputSchema,
    );
  },
  context(input: BoardSpotlightContextInput) {
    return invokeWithSchema(
      CH.boardSpotlight.context,
      input,
      boardSpotlightContextInputSchema,
    );
  },
  tapePoll(input: BoardTapePollInput) {
    return invokeWithSchema(
      CH.boardSpotlight.tapePoll,
      input,
      boardTapePollInputSchema,
    );
  },
} satisfies BoardSpotlightBridge;
