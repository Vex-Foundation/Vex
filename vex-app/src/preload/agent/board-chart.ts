import { CH } from "../../shared/ipc/channels.js";
import {
  boardChartPollInputSchema,
  type BoardChartPollInput,
} from "../../shared/schemas/board-chart.js";
import type { BoardChartBridge } from "../../shared/types/bridge/agent/board-chart.js";
import { abortableInvoke } from "../_dispatch.js";

/**
 * vex.boardChart.* - the spotlight chart's own poll.
 *
 * A named domain method only: no channel string, no `ipcRenderer`, and no way
 * for the renderer to name anything but the pool it is already displaying and
 * one of four pill resolutions. The input is validated HERE as well as in main,
 * so a renderer defect is refused at the boundary it belongs to.
 */
export const boardChart = {
  /**
   * ABORTABLE, and that is the whole point of a renderer-timed poll.
   *
   * The spotlight scope owns this channel's clock, so leaving the spotlight,
   * switching pill or closing the modal cuts a tick that is already in flight.
   * Main aborts the provider read on `ctx.signal`, and that signal can only
   * fire if this side can fire it; without `cancel`, a cut would stop the
   * renderer LISTENING while main read a chart nobody is watching. What the
   * renderer gains is "I have stopped waiting" - never a timeout and never a
   * budget, both of which stay main-process constants.
   */
  poll(input: BoardChartPollInput) {
    return abortableInvoke(CH.boardChart.poll, input, boardChartPollInputSchema);
  },
} satisfies BoardChartBridge;
