import { CH, EV } from "../../shared/ipc/channels.js";
import { vexMarketSnapshotSchema } from "../../shared/schemas/market.js";
import type { MarketBridge } from "../../shared/types/bridge/shell/market.js";
import { invokeWithSchema, subscribe } from "../_dispatch.js";

/**
 * vex.market.* — read-only live VEX market snapshot bridge (T1).
 *
 * Business methods only; the renderer never imports the DexScreener or
 * Virtuals clients and never sees a raw channel. Snapshots arrive via
 * `onVexUpdate` (main-pushed, Zod-validated at the preload boundary — an
 * off-contract payload is dropped before the callback runs). Mirrors
 * `shell/updater.ts`.
 */
export const market = {
  getVexSnapshot() {
    return invokeWithSchema(CH.market.getVexSnapshot, {});
  },
  onVexUpdate(cb) {
    return subscribe(EV.market.vex, vexMarketSnapshotSchema, cb);
  },
} satisfies MarketBridge;
