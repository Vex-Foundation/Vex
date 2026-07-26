/**
 * Sync-executor worker ownership (F11).
 *
 * Electron main owns the engine's sync executor so post-mutation
 * `protocol_sync_runs` actually drain into refreshed portfolio/balance
 * projections — without this, every mutating protocol tool enqueues a run that
 * sits `pending` forever and the renderer shows stale balances/positions.
 *
 * Unlike the compact and wake workers, the sync executor has NO provider gate:
 * it makes no OpenRouter/inference calls. What it DOES do is PUBLIC-ADDRESS
 * NETWORK READS — `initSync()` snapshots balances and `syncTick()` refreshes
 * projections by querying Khalani/Jupiter with the wallet's PUBLIC
 * addresses. No keystore unlock and no private key are involved. The only start
 * gate is this SUPERVISOR proving Postgres + the `protocol_sync_jobs` schema are
 * ready (not merely that `VEX_DB_URL` resolves). Consequence: once the schema is
 * ready the executor can start BEFORE the vault is unlocked, so public-address
 * network egress may begin pre-unlock — an accepted privacy trade-off (the
 * addresses are public; no secret material is touched).
 *
 * Lifecycle mirrors `wake-worker.ts`: tick immediately then every
 * `SUPERVISOR_INTERVAL_MS` until the DB is ready, then start the executor
 * EXACTLY ONCE and clear the interval (the executor self-schedules thereafter).
 * `stop()` is non-reentrant and idempotent: clears the interval, awaits any
 * in-flight startup tick, and stops the executor if started — a probe/import
 * that resolves AFTER quit begins must NOT leave a live executor.
 *
 * `stop()` is sequenced BEFORE compose/Postgres teardown via
 * `makeOrderedQuitCleanup` in `index.ts`, so an in-flight tick drains against a
 * live DB.
 */

import { randomUUID } from "node:crypto";
import type { SyncExecutorHandle } from "@vex-agent/sync/executor.js";
import { log } from "../logger/index.js";
import { probeProtocolSyncReady } from "../database/sync-db.js";
import { ensureEngineDbUrl } from "../ipc/runtime/_ensure-engine-db-url.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface SyncWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `protocol_sync_jobs` migrated before starting. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's sync executor (narrow dynamic import by default). */
  readonly startExecutor: () => Promise<SyncExecutorHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartExecutor(): Promise<SyncExecutorHandle> {
  // Narrow import (not the `engine/index.js` barrel) to avoid pulling the full
  // runner graph into the supervisor's import chain. `startSyncExecutor` is
  // synchronous; the async wrapper keeps the dep type `() => Promise<...>`.
  const { startSyncExecutor } = await import("@vex-agent/sync/executor.js");
  return startSyncExecutor();
}

/**
 * Start the supervised sync worker. Returns an idempotent async `stop` for the
 * ordered quit cleanup. Deps are injectable for tests; production uses the real
 * DB-url helper, schema probe, and narrow executor import.
 */
export function setupSyncWorker(
  deps: Partial<SyncWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeProtocolSyncReady;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;

  let stopped = false;
  let started = false;
  let handle: SyncExecutorHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlightTick: Promise<void> | null = null;
  let warnedWaiting = false;

  const clearTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const warnWaitingOnce = (reason: string): void => {
    if (warnedWaiting) return;
    warnedWaiting = true;
    log.info(`[sync-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(`sync-worker-supervisor-${randomUUID()}`);
    if (stopped || started) return; // re-check after await (non-reentrant)
    if (!dbUrl.ok) {
      warnWaitingOnce("database url unavailable");
      return;
    }

    const ready = await probeReady();
    if (stopped || started) return; // re-check after await
    if (!ready) {
      warnWaitingOnce("protocol_sync_jobs schema not ready");
      return;
    }

    const live = await startExecutor();
    started = true;
    clearTimer();
    // stop() may have raced in during `startExecutor`'s await — if so, tear
    // down the executor we just created so quit never leaves a live worker.
    if (stopped) {
      await live.stop();
      return;
    }
    handle = live;
    log.info("[sync-worker] sync executor started");
  };

  const scheduleTick = (): void => {
    // Single in-flight tick: a slow tick must not be lapped by the interval
    // (that would orphan the earlier tick's promise from `stop()`).
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[sync-worker] supervisor tick failed", err);
      })
      .finally(() => {
        inFlightTick = null;
      });
  };

  scheduleTick();
  timer = setInterval(scheduleTick, intervalMs);

  return async function stop(): Promise<void> {
    stopped = true;
    clearTimer();
    // Drain an in-flight startup tick first: it re-checks `stopped` after each
    // await and tears down any executor it managed to start.
    if (inFlightTick !== null) {
      try {
        await inFlightTick;
      } catch {
        // already logged in scheduleTick
      }
    }
    if (handle !== null) {
      const live = handle;
      handle = null;
      await live.stop();
    }
  };
}
