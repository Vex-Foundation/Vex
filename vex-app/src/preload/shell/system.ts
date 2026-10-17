import { CH, EV } from "../../shared/ipc/channels.js";
import { nativeRuntimeStatusSchema } from "../../shared/schemas/system.js";
import type { SystemBridge } from "../../shared/types/bridge/shell/system.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

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
  runtime() {
    return invokeWithSchema(CH.system.runtime, {});
  },
  runtimeStatus() {
    return invokeWithSchema(CH.system.runtimeStatus, {});
  },
  runtimeRetry() {
    return invokeWithSchema(CH.system.runtimeRetry, {});
  },
  onRuntimeProgress(cb) {
    return subscribe(EV.system.runtimeProgress, nativeRuntimeStatusSchema, cb);
  },
  notifyTurnComplete(input) {
    return invokeWithSchema(CH.system.notifyTurnComplete, input);
  },
  setTitleBarOverlay(input) {
    return invokeWithSchema(CH.system.setTitleBarOverlay, input);
  },
} satisfies SystemBridge;
