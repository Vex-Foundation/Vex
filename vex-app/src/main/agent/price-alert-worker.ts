/**
 * Price-alert worker ownership (F01).
 *
 * Electron main owns the engine's price alert poller so the user's alerts
 * actually fire: without it every alert set from chat or the Watchlist page
 * waits forever. The poller reads public DexScreener prices and writes only
 * the alert rows; it makes no inference call, needs no key and touches no
 * signer, so like the sync worker it has NO provider gate and does not wait
 * for the vault. Locking the vault does not stop it: alerts keep firing.
 *
 * The only start gate is this SUPERVISOR proving Postgres is reachable, the
 * migrations ran, and `price_alerts` exists. Lifecycle mirrors
 * `sync-worker.ts`: tick immediately, then every `SUPERVISOR_INTERVAL_MS`
 * until the DB is ready, then start the executor EXACTLY ONCE and clear the
 * interval (the executor self-schedules thereafter). `stop()` is idempotent:
 * it clears the interval, awaits any in-flight startup tick, and stops the
 * executor if started, so a probe or import that resolves after quit begins
 * never leaves a live poller.
 *
 * `stop()` runs as its own named stage before the Postgres teardown, so an
 * in-flight tick drains against a live DB.
 */

import { randomUUID } from "node:crypto";
import type { PriceAlertExecutorHandle } from "@vex-agent/alerts/price-alert-executor.js";
import { log } from "../logger/index.js";
import { probePriceAlertsReady } from "../database/price-alerts-db.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { migrationsApplied } from "../database/migrations-applied.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface PriceAlertWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `price_alerts` migrated before starting. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's price alert poller (narrow dynamic import by default). */
  readonly startExecutor: () => Promise<PriceAlertExecutorHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartExecutor(): Promise<PriceAlertExecutorHandle> {
  // Narrow import, not the engine barrel. `startPriceAlertExecutor` is
  // synchronous; the async wrapper keeps the dep type `() => Promise<...>`.
  const { startPriceAlertExecutor } = await import("@vex-agent/alerts/price-alert-executor.js");
  return startPriceAlertExecutor();
}

/**
 * Start the supervised price-alert worker. Returns an idempotent async `stop`
 * for the ordered quit cleanup. Deps are injectable for tests.
 */
export function setupPriceAlertWorker(
  deps: Partial<PriceAlertWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probePriceAlertsReady;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;

  let stopped = false;
  let started = false;
  let handle: PriceAlertExecutorHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlightTick: Promise<void> | null = null;
  const loggedWaitReasons = new Set<string>();

  const clearTimer = (): void => {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };

  const warnWaitingOnce = (reason: string): void => {
    if (loggedWaitReasons.has(reason)) return;
    loggedWaitReasons.add(reason);
    log.info(`[price-alert-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(`price-alert-worker-supervisor-${randomUUID()}`);
    if (stopped || started) return;
    if (!dbUrl.ok) {
      warnWaitingOnce("database url unavailable");
      return;
    }

    if (!migrationsApplied()) {
      warnWaitingOnce("migrations pending");
      return;
    }

    const ready = await probeReady();
    if (stopped || started) return;
    if (!ready) {
      warnWaitingOnce("price_alerts schema not ready");
      return;
    }

    const live = await startExecutor();
    started = true;
    clearTimer();
    // stop() may have raced in during `startExecutor`'s await: tear down the
    // poller just created so quit never leaves a live worker.
    if (stopped) {
      await live.stop();
      return;
    }
    handle = live;
    log.info("[price-alert-worker] price alert poller started");
  };

  const scheduleTick = (): void => {
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[price-alert-worker] supervisor tick failed", err);
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
