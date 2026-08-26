import { CH } from "../../shared/ipc/channels.js";
import {
  boardIconReadInputSchema,
  type BoardIconReadInput,
} from "../../shared/schemas/board-icons.js";
import type { BoardIconsBridge } from "../../shared/types/bridge/agent/board-icons.js";
import { invokeWithSchema } from "../_dispatch.js";

/**
 * Board token icons. One named domain method, no channel string, no
 * `ipcRenderer`, and no way for the renderer to name an origin: the input is an
 * opaque handle and main owns every other decision about the fetch.
 */
export const boardIcons = {
  read(input: BoardIconReadInput) {
    return invokeWithSchema(CH.boardIcons.read, input, boardIconReadInputSchema);
  },
} satisfies BoardIconsBridge;
