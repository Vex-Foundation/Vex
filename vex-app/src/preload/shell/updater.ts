import { CH, EV } from "../../shared/ipc/channels.js";
import { updateStatusSchema } from "../../shared/schemas/updater.js";
import type { UpdaterBridge } from "../../shared/types/bridge/shell/updater.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * vex.updater.* — user-triggered in-app update bridge (M13).
 *
 * Business methods only; the renderer never imports electron-updater / electron
 * and never sees a raw channel. Status arrives via `onStatus` (main-pushed,
 * Zod-validated at the preload boundary). Mirrors `shell/system.ts`.
 */
export const updater = {
  getStatus() {
    return invokeWithSchema(CH.updater.getStatus, {});
  },
  checkNow() {
    return invokeWithSchema(CH.updater.check, {});
  },
  startUpdateNow() {
    return invokeWithSchema(CH.updater.startUpdateNow, {});
  },
  cancelDownload() {
    return invokeWithSchema(CH.updater.cancelDownload, {});
  },
  restartAndInstallNow() {
    return invokeWithSchema(CH.updater.restartAndInstallNow, {});
  },
  openReleaseNotes() {
    return invokeWithSchema(CH.updater.openReleaseNotes, {});
  },
  onStatus(cb) {
    return subscribe(EV.updater.status, updateStatusSchema, cb);
  },
} satisfies UpdaterBridge;
