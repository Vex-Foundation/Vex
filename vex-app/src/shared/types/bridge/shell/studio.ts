import type { Result } from "../../../ipc/result.js";
import type { StudioHostStatus } from "../../../schemas/studio.js";

/**
 * `vex.studio.*` - read-only Vex Studio host-status surface (stage B0).
 *
 * The renderer reads the first value through `getHostStatus` and keeps it live
 * via `onHostStatus` (main-pushed, Zod-validated at the preload boundary).
 * Mirrors `MarketBridge`'s read-once + subscribe shape.
 *
 * There is no method here that starts, stops or locks the host: those are
 * consequences of unlocking, relocking and quitting Vex, and the renderer holds
 * no authority over any of them.
 */
export interface StudioBridge {
  /**
   * The host's current status from main's cache. Never `null` - before the
   * host has started, the honest answer is `unavailable` with cause
   * `starting`, which the renderer can render directly.
   */
  readonly getHostStatus: () => Promise<Result<StudioHostStatus>>;
  /**
   * Subscribe to main-pushed host-status transitions. Returns an idempotent
   * unsubscribe - call it from the React effect cleanup. Identical consecutive
   * payloads are coalesced by main, and an off-contract payload is dropped at
   * the preload boundary before it can reach the callback.
   */
  readonly onHostStatus: (
    cb: (status: StudioHostStatus) => void,
  ) => () => void;
}
