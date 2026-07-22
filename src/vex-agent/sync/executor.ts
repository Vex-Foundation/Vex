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
import { startHyperliquidMarketWatcher, type HyperliquidMarketWatcherHandle } from "./hyperliquid-market-watcher.js";
import { subscribeSyncTickWake } from "./executor-wake.js";
import logger from "@utils/logger.js";

export interface SyncExecutorHandle {
  /** Stop the executor. Resolves after any in-flight init/tick settles. */
  stop(): Promise<void>;
}

export interface SyncExecutorDeps {
  initSync(): Promise<void>;
  syncTick(): Promise<void>;
  /** Production owns this external watch lease beside the sync scheduler. */
  startHyperliquidMarketWatcher?(): HyperliquidMarketWatcherHandle;
}

export interface SyncStartOptions {
  /** How often to call `syncTick()` after the initial `initSync()` succeeds. */
  intervalMs?: number;
  /** Dependency injection for tests. */
  deps?: SyncExecutorDeps;
}

const DEFAULT_SYNC_INTERVAL_MS = 60_000;

function buildProductionDeps(): SyncExecutorDeps {
  return { initSync, syncTick, startHyperliquidMarketWatcher };
}

export function startSyncExecutor(options: SyncStartOptions = {}): SyncExecutorHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
  const deps = options.deps ?? buildProductionDeps();

  let stopped = false;
  let initialized = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let marketWatcher: HyperliquidMarketWatcherHandle | null = null;
  let wakePending = false;

  const runOne = async (): Promise<void> => {
    try {
      if (!initialized) {
        await deps.initSync();
        initialized = true;
        marketWatcher = deps.startHyperliquidMarketWatcher?.() ?? null;
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
      timer = null;
      inFlight = runOne().finally(() => {
        inFlight = null;
        const nextDelay = wakePending && initialized ? 0 : intervalMs;
        wakePending = false;
        schedule(nextDelay);
      });
    }, delayMs);
  };

  const unsubscribeWake = subscribeSyncTickWake(() => {
    if (stopped) return;
    if (inFlight !== null || !initialized) {
      wakePending = true;
      return;
    }
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    schedule(0);
  });

  schedule(0);
  logger.info("sync.executor.started", { intervalMs });

  return {
    async stop(): Promise<void> {
      stopped = true;
      unsubscribeWake();
      if (timer) clearTimeout(timer);
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged by runOne.
        }
      }
      if (marketWatcher) {
        const active = marketWatcher;
        marketWatcher = null;
        await active.stop();
      }
      logger.info("sync.executor.stopped");
    },
  };
}
