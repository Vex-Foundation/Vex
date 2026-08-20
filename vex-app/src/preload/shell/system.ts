import { CH } from "../../shared/ipc/channels.js";
import type { SystemBridge } from "../../shared/types/bridge/shell/system.js";
import { invokeWithSchema } from "../_dispatch.js";

export const system = {
  health() {
    return invokeWithSchema(CH.system.health, {});
  },
  osInfo() {
    return invokeWithSchema(CH.system.osInfo, {});
  },
  network() {
    return invokeWithSchema(CH.system.network, {});
  },
  notifyTurnComplete(input) {
    return invokeWithSchema(CH.system.notifyTurnComplete, input);
  },
} satisfies SystemBridge;
