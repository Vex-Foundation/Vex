import { CH, EV } from "../../shared/ipc/channels.js";
import { studioHostStatusSchema } from "../../shared/schemas/studio.js";
import type { StudioBridge } from "../../shared/types/bridge/shell/studio.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * vex.studio.* - the read-only Vex Studio bridge (host status, stage B0; bridge
 * readiness, stage B1.6).
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
  getBridgeReadiness() {
    return invokeWithSchema(CH.studio.bridgeReadiness, {});
  },
} satisfies StudioBridge;
