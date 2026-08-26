import { CH } from "../../shared/ipc/channels.js";
import {
  boardSparklineHydrateInputSchema,
  type BoardSparklineHydrateInput,
} from "../../shared/schemas/board-sparkline.js";
import type { BoardSparklineBridge } from "../../shared/types/bridge/agent/board-sparkline.js";
import { abortableInvoke } from "../_dispatch.js";

/**
 * vex.boardSparkline.* - the board's cold candle hydration.
 *
 * One named domain method: no channel string, no `ipcRenderer`, and no way for
 * the renderer to name a bar count, a deadline or a transport. The input is
 * validated HERE as well as in main, so a renderer defect is refused at the
 * boundary it belongs to rather than travelling to the privileged side.
 */
export const boardSparkline = {
  /**
   * ABORTABLE, because the service's own contract says cancellation IS the
   * modal close.
   *
   * `board-sparkline-service.ts` owns a progressive queue and a thirty second
   * board-wide budget, and it stops admitting pools the moment `ctx.signal`
   * fires. That signal is reachable only through a `cancel` on this side, so
   * without one the documented cancellation could never happen and closing a
   * board would leave a queue running for a surface nobody is looking at.
   */
  hydrate(input: BoardSparklineHydrateInput) {
    return abortableInvoke(
      CH.boardSparkline.hydrate,
      input,
      boardSparklineHydrateInputSchema,
    );
  },
} satisfies BoardSparklineBridge;
