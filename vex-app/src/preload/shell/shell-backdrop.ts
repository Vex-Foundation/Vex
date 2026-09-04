import { CH } from "../../shared/ipc/channels.js";
import {
  shellBackdropClearInputSchema,
  shellBackdropPickInputSchema,
  shellBackdropReadInputSchema,
} from "../../shared/schemas/shell-backdrop.js";
import type { ShellBackdropBridge } from "../../shared/types/bridge/shell/shell-backdrop.js";
import { invokeWithSchema } from "../_dispatch.js";

/**
 * The user backdrop. Three named domain methods, no channel string, no
 * `ipcRenderer`, and no way for the renderer to name a path or an id: every
 * payload is the empty strict object, validated here before it crosses.
 */
export const shellBackdrop = {
  pick() {
    return invokeWithSchema(CH.shellBackdrop.pick, {}, shellBackdropPickInputSchema);
  },
  clear() {
    return invokeWithSchema(CH.shellBackdrop.clear, {}, shellBackdropClearInputSchema);
  },
  read() {
    return invokeWithSchema(CH.shellBackdrop.read, {}, shellBackdropReadInputSchema);
  },
} satisfies ShellBackdropBridge;
