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

import { initSync, syncTick } from "./index.js";
import logger from "@utils/logger.js";

export interface SyncExecutorHandle {
  /** Stop the executor. Resolves after any in-flight init/tick settles. */
  stop(): Promise<void>;
}

export interface SyncExecutorDeps {
  initSync(): Promise<void>;
  syncTick(): Promise<void>;
}

export interface SyncStartOptions {
  /** How often to call `syncTick()` after the initial `initSync()` succeeds. */
  intervalMs?: number;
  /** Dependency injection for tests. */
  deps?: SyncExecutorDeps;
}

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

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
        await deps.initSync();
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

  schedule(0);
  logger.info("sync.executor.started", { intervalMs });

  return {
    async stop(): Promise<void> {
      stopped = true;
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
