import { CH, EV } from "../../shared/ipc/channels.js";
import { studioHostStatusSchema } from "../../shared/schemas/studio.js";
import type { StudioBridge } from "../../shared/types/bridge/shell/studio.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * vex.studio.* - read-only Vex Studio host-status bridge (stage B0).
 *
 * Business methods only; the renderer never sees a raw channel and never
 * learns the host's endpoint - the payload has no field to carry one, and its
 * `.strict()` schema drops any that appears. Status updates arrive via
 * `onHostStatus` (main-pushed, Zod-validated here, off-contract payloads
 * dropped before the callback runs). Mirrors `shell/market.ts`.
 */
export const studio = {
  getHostStatus() {
    return invokeWithSchema(CH.studio.hostStatus, {});
  },
  onHostStatus(cb) {
    return subscribe(EV.studio.hostStatus, studioHostStatusSchema, cb);
  },
} satisfies StudioBridge;
