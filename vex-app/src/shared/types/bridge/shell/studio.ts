import type { Result } from "../../../ipc/result.js";
import type { StudioBridgeReadiness } from "../../../schemas/studio-bridge-readiness.js";
import type { StudioHostStatus } from "../../../schemas/studio.js";

/**
 * `vex.studio.*` - the read-only Vex Studio surface.
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
  /**
   * Does this installation have a `vex-mcp` bridge binary, and when it does
   * not, the one thing the user can do about it (stage B1.6).
   *
   * A PULL with no subscription twin, unlike the host status: the answer moves
   * only when somebody installs a toolchain or runs a build outside Vex, which
   * nothing in this process observes. The re-check button calls this again.
   *
   * Read-only and idempotent, so calling it repeatedly is safe. It carries
   * closed state codes and, on a from-source run, two pattern-bounded Go
   * version tokens. It never carries a filesystem path.
   */
  readonly getBridgeReadiness: () => Promise<Result<StudioBridgeReadiness>>;
}
