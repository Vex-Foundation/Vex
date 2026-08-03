/**
 * Sync executor — single-process scheduler for portfolio projection refreshes.
 *
 * The sync API is intentionally split:
 * - `initSync()` seeds jobs, drains stale pending runs, and creates a startup
 *   balance snapshot.
 * - `syncTick()` drains post-mutation runs and checks due periodic jobs.
 *
 * This executor owns the process-lifetime loop for the long-lived desktop
 * agent host. Short-lived bootstrap checks must not start it.
 */

import { initSync, syncTick, type InitSyncOptions } from "./index.js";
import { startFastLane, type FastLaneHandle } from "./fast-lane.js";
import logger from "@utils/logger.js";

export interface SyncExecutorHandle {
  /** Stop the executor. Resolves after any in-flight init/tick settles. */
  stop(): Promise<void>;
}

export interface SyncExecutorDeps {
  initSync(options?: InitSyncOptions): Promise<void>;
  syncTick(): Promise<void>;
}

export interface SyncStartOptions {
  /** How often to call `syncTick()` after the initial `initSync()` succeeds. */
  intervalMs?: number;
  /** Dependency injection for tests. */
  deps?: SyncExecutorDeps;
  /**
   * Start the per-row fast lane alongside the tick. Defaults to `true`; tests
   * that only exercise tick scheduling turn it off so no wheel timer or bus
   * subscription leaks between cases.
   */
  fastLane?: boolean;
}

// 30s: the tick is a hard FLOOR for every periodic job's cadence, and the
// status-only activity repair sweeps run at 30s (migration 061). A 60s tick
// would silently halve them.
//
// This is NO LONGER the pending-resolution SLA (Wave P). Real-time resolution
// belongs to the fast lane below, which watches a specific freshly-broadcast row
// at 12s; the tick remains the cadence of the GLOBAL sweeps, which are the
// safety net for every row the fast lane never saw or aged out.
const DEFAULT_SYNC_INTERVAL_MS = 30_000;

function buildProductionDeps(): SyncExecutorDeps {
  return { initSync, syncTick };
}

export function startSyncExecutor(options: SyncStartOptions = {}): SyncExecutorHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const deps = options.deps ?? buildProductionDeps();

  let stopped = false;
  let initialized = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const runOne = async (): Promise<void> => {
    try {
      if (!initialized) {
        // The fast lane is already subscribed, so hand `initSync` the registry's
        // own size: its crash-recovery re-arm can then report lanes ACCEPTED
        // rather than candidates emitted.
        await deps.initSync({ activeLaneCount: () => fastLane?.size() ?? 0 });
        initialized = true;
        return;
      }
      await deps.syncTick();
    } catch (err) {
      logger.error("sync.executor.tick_failed", {
        initialized,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(() => {
      inFlight = runOne().finally(() => {
        inFlight = null;
        schedule(intervalMs);
      });
    }, delayMs);
  };

  // Subscribed BEFORE the first `schedule(0)`: `initSync` re-arms crash-recovery
  // lanes through the bus, and a subscription taken afterwards would miss them.
  const fastLane: FastLaneHandle | null =
    (options.fastLane ?? true) ? startFastLane() : null;

  schedule(0);
  logger.info("sync.executor.started", { intervalMs, fastLane: fastLane !== null });

  return {
    async stop(): Promise<void> {
      stopped = true;
      fastLane?.stop();
      if (timer) clearTimeout(timer);
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged by runOne.
        }
      }
      logger.info("sync.executor.stopped");
    },
  };
}
