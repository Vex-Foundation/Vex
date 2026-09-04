/**
 * memory_manager worker ownership (S4 §4/§10 — R3 #2/#3).
 *
 * Electron main owns the engine's memory_manager executor so enqueued
 * `memory_jobs` (consolidate sweeps from `long_memory_suggest`) actually process
 * candidates into long-term knowledge — without this they sit `pending` forever.
 * Enabled by default; two independent gates keep it safe:
 *   - the executor's OWN pre-claim provider gate keeps it idle (no DB claim, no
 *     OpenRouter egress) until the vault injects OPENROUTER_API_KEY + AGENT_MODEL;
 *   - this supervisor only STARTS the executor once Postgres + the `memory_jobs`
 *     schema are actually ready (not merely once `VEX_DB_URL` resolves), so the
 *     bootstrap/claim path never spams errors.
 *
 * Lifecycle mirrors `compact-worker.ts` / `sync-worker.ts`: tick immediately then
 * every `SUPERVISOR_INTERVAL_MS` until the DB is ready, then start the executor
 * EXACTLY ONCE and clear the interval (the executor self-schedules thereafter).
 * `stop()` is non-reentrant and idempotent: clears the interval, awaits any
 * in-flight startup tick, and stops the executor if started — a probe/import that
 * resolves AFTER quit begins must NOT leave a live executor.
 *
 * `stop()` is sequenced BEFORE compose/Postgres teardown via
 * `makeOrderedQuitCleanup` in `index.ts`, so an in-flight consolidate job drains
 * against a live DB.
 */

import { randomUUID } from "node:crypto";
import type { MemoryManagerExecutorHandle } from "@vex-agent/engine/memory-manager/executor.js";
import { log } from "../logger/index.js";
import { probeMemoryJobsReady } from "../database/memory-jobs-db.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { migrationsApplied } from "../database/migrations-applied.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface MemoryManagerWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `memory_jobs` migrated before starting. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's memory_manager executor (narrow dynamic import by default). */
  readonly startExecutor: () => Promise<MemoryManagerExecutorHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartExecutor(): Promise<MemoryManagerExecutorHandle> {
  // Narrow import (not the `engine/index.js` barrel) to avoid pulling the full
  // runner graph into the supervisor's import chain.
  const { startMemoryManagerExecutor } = await import(
    "@vex-agent/engine/memory-manager/executor.js"
  );
  return startMemoryManagerExecutor();
}

/**
 * Start the supervised memory_manager worker. Returns an idempotent async `stop`
 * for the ordered quit cleanup. Deps are injectable for tests; production uses
 * the real DB-url helper, schema probe, and narrow executor import.
 */
export function setupMemoryManagerWorker(
  deps: Partial<MemoryManagerWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeMemoryJobsReady;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;

  let stopped = false;
  let started = false;
  let handle: MemoryManagerExecutorHandle | null = null;
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
    log.info(`[memory-manager-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(
      `memory-manager-worker-supervisor-${randomUUID()}`,
    );
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
      warnWaitingOnce("memory_jobs schema not ready");
      return;
    }

    const live = await startExecutor();
    started = true;
    clearTimer();
    // stop() may have raced in during `startExecutor`'s await — if so, tear down
    // the executor we just created so quit never leaves a live worker.
    if (stopped) {
      await live.stop();
      return;
    }
    handle = live;
    log.info("[memory-manager-worker] memory_manager executor started");
  };

  const scheduleTick = (): void => {
    // Single in-flight tick: a slow tick must not be lapped by the interval
    // (that would orphan the earlier tick's promise from `stop()`).
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[memory-manager-worker] supervisor tick failed", err);
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
