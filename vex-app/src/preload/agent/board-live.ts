import { CH, EV } from "../../shared/ipc/channels.js";
import {
  boardLiveEventSchema,
  boardLiveSubscribeInputSchema,
  boardLiveUnsubscribeInputSchema,
  type BoardLiveSubscribeInput,
  type BoardLiveUnsubscribeInput,
} from "../../shared/schemas/board-live.js";
import type { BoardLiveBridge } from "../../shared/types/bridge/agent/board-live.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * vex.boardLive.* - the board's LIVE lease bridge.
 *
 * Named domain methods only: no channel string, no `ipcRenderer`, no way for
 * the renderer to name anything but the pools it is already displaying. Lease
 * events are Zod-validated here, so an off-contract payload is dropped before
 * it can reach renderer state, and `onLeaseEvent` returns the idempotent
 * unsubscribe the React effect cleanup calls.
 */
export const boardLive = {
  capability() {
    return invokeWithSchema(CH.boardLive.capability, {});
  },
  subscribe(input: BoardLiveSubscribeInput) {
    return invokeWithSchema(
      CH.boardLive.subscribe,
      input,
      boardLiveSubscribeInputSchema,
    );
  },
  unsubscribe(input: BoardLiveUnsubscribeInput) {
    return invokeWithSchema(
      CH.boardLive.unsubscribe,
      input,
      boardLiveUnsubscribeInputSchema,
    );
  },
  onLeaseEvent(cb: Parameters<BoardLiveBridge["onLeaseEvent"]>[0]) {
    return subscribe(EV.board.live, boardLiveEventSchema, cb);
  },
} satisfies BoardLiveBridge;
