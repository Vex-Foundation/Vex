/**
 * Wake-executor worker ownership (F2).
 *
 * Electron main owns the engine's wake executor so `loop_defer`-scheduled
 * `paused_wake` mission runs actually resume — without this they sleep forever.
 * Two independent gates keep it safe, mirroring the compact worker:
 *   - the wake EXECUTOR's OWN pre-claim provider/config gate keeps it from
 *     consuming wake rows (`claimDue` is destructive: pending→consumed) until
 *     OPENROUTER_API_KEY + AGENT_MODEL are in env (vault unlocked + provider
 *     configured);
 *   - this SUPERVISOR only STARTS the executor once Postgres + the
 *     `loop_wake_requests` schema are ready (not merely once `VEX_DB_URL`
 *     resolves), so the bootstrap/claim path never spams errors.
 *
 * Lifecycle mirrors `compact-worker.ts`: tick immediately then every
 * `SUPERVISOR_INTERVAL_MS` until the DB is ready, then start the executor
 * EXACTLY ONCE and clear the interval (the executor self-schedules + self-gates
 * thereafter). `stop()` is non-reentrant and idempotent: clears the interval,
 * awaits any in-flight startup tick, and stops the executor if started — a
 * probe/import that resolves AFTER quit begins must NOT leave a live executor.
 *
 * `stop()` is sequenced BEFORE compose/Postgres teardown via
 * `makeOrderedQuitCleanup` in `index.ts`, so an in-flight resume drains against
 * a live DB.
 */

import { randomUUID } from "node:crypto";
import type { WakeExecutorHandle } from "@vex-agent/engine/wake/executor.js";
import { log } from "../logger/index.js";
import { probeLoopWakeReady } from "../database/wake-db.js";
import { ensureEngineDbUrl } from "../ipc/runtime/_ensure-engine-db-url.js";
import { migrationsApplied } from "../database/migrations-applied.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface WakeWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `loop_wake_requests` migrated before starting. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's wake executor (narrow dynamic import by default). */
  readonly startExecutor: () => Promise<WakeExecutorHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartExecutor(): Promise<WakeExecutorHandle> {
  // Narrow import (not the `engine/index.js` barrel) to avoid pulling the full
  // runner graph into the supervisor's import chain.
  const { startWakeExecutor } = await import(
    "@vex-agent/engine/wake/executor.js"
  );
  return startWakeExecutor();
}

/**
 * Start the supervised wake worker. Returns an idempotent async `stop` for the
 * ordered quit cleanup. Deps are injectable for tests; production uses the real
 * DB-url helper, schema probe, and narrow executor import.
 */
export function setupWakeWorker(
  deps: Partial<WakeWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeLoopWakeReady;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;

  let stopped = false;
  let started = false;
  let handle: WakeExecutorHandle | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inFlightTick: Promise<void> | null = null;
  // One line per DISTINCT wait reason: a worker that waited on the DB url and
  // then on migrations must report both, not only whichever came first.
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
    log.info(`[wake-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(`wake-worker-supervisor-${randomUUID()}`);
    if (stopped || started) return; // re-check after await (non-reentrant)
    if (!dbUrl.ok) {
      warnWaitingOnce("database url unavailable");
      return;
    }

    // Schema VERSION, not schema presence — see `database/migrations-applied.ts`.
    if (!migrationsApplied()) {
      warnWaitingOnce("migrations pending");
      return;
    }

    const ready = await probeReady();
    if (stopped || started) return; // re-check after await
    if (!ready) {
      warnWaitingOnce("loop_wake_requests schema not ready");
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
    log.info("[wake-worker] wake executor started");
  };

  const scheduleTick = (): void => {
    // Single in-flight tick: a slow tick must not be lapped by the interval
    // (that would orphan the earlier tick's promise from `stop()`).
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[wake-worker] supervisor tick failed", err);
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
