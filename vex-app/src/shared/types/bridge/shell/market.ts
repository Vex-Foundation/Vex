import type { Result } from "../../../ipc/result.js";
import type { VexMarketSnapshot } from "../../../schemas/market.js";

/**
 * `vex.market.*` — read-only live VEX market snapshot surface (T1).
 *
 * The renderer never fetches DexScreener or Virtuals directly;
 * it reads the first value through `getVexSnapshot` and keeps it live via
 * `onVexUpdate` (main-pushed, Zod-validated at the preload boundary). Mirrors
 * `UpdaterBridge`'s read-once + subscribe shape.
 */
export interface MarketBridge {
  /**
   * Last-known snapshot from main's cache (no network call). `null` until the
   * first poll completes — the renderer renders a loading state, not an error.
   */
  readonly getVexSnapshot: () => Promise<Result<VexMarketSnapshot | null>>;
  /**
   * Subscribe to main-pushed snapshot broadcasts. Returns an idempotent
   * unsubscribe — call it from the React effect cleanup. The renderer never
   * sees the raw IPC channel, and an off-contract payload is dropped at the
   * preload boundary before it can reach the callback.
   */
  readonly onVexUpdate: (
    cb: (snapshot: VexMarketSnapshot) => void,
  ) => () => void;
}
