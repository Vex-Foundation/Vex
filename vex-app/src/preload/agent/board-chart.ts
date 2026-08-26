import { CH } from "../../shared/ipc/channels.js";
import {
  boardChartPollInputSchema,
  type BoardChartPollInput,
} from "../../shared/schemas/board-chart.js";
import type { BoardChartBridge } from "../../shared/types/bridge/agent/board-chart.js";
import { invokeWithSchema } from "../_dispatch.js";

/**
 * vex.boardChart.* - the spotlight chart's own poll.
 *
 * A named domain method only: no channel string, no `ipcRenderer`, and no way
 * for the renderer to name anything but the pool it is already displaying and
 * one of four pill resolutions. The input is validated HERE as well as in main,
 * so a renderer defect is refused at the boundary it belongs to.
 */
export const boardChart = {
  poll(input: BoardChartPollInput) {
    return invokeWithSchema(CH.boardChart.poll, input, boardChartPollInputSchema);
  },
} satisfies BoardChartBridge;
