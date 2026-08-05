/**
 * Compact-jobs Track-2 worker ownership (agent integration stage 7-1).
 *
 * Electron main owns the engine's Track-2 executor so enqueued `compact_jobs`
 * actually process into session memory — without this they sit `pending`
 * forever. Enabled by default; two independent gates keep it safe:
 *   - the executor's OWN provider-config gate keeps it idle (no DB claim, no
 *     OpenRouter egress) until the vault injects `OPENROUTER_API_KEY`;
 *   - this supervisor only STARTS the executor once Postgres + the
 *     `compact_jobs` schema are actually ready (not merely once `VEX_DB_URL`
 *     resolves), so the bootstrap/claim path never spams errors.
 *
 * Lifecycle:
 *   - the supervisor ticks immediately (fast start when the DB is already up
 *     on relaunch), then every `SUPERVISOR_INTERVAL_MS`, until the DB is
 *     ready; then it starts the executor EXACTLY ONCE and clears the interval
 *     (the executor self-schedules thereafter);
 *   - `stop()` is non-reentrant: sets `stopped`, clears the interval, awaits
 *     any in-flight startup tick, and stops the executor if started. A probe
 *     /import that resolves AFTER quit begins must NOT leave a live executor.
 *
 * `stop()` is sequenced BEFORE compose/Postgres teardown via
 * `makeOrderedQuitCleanup` in `index.ts`, so an in-flight Track-2 job drains
 * against a live DB.
 */

import { randomUUID } from "node:crypto";
import type { CompactJobsExecutorHandle } from "@vex-agent/engine/compact-jobs/executor.js";
import { log } from "../logger/index.js";
import { probeCompactJobsReady } from "../database/compaction-db.js";
import { ensureEngineDbUrl } from "../ipc/runtime/_ensure-engine-db-url.js";
import { migrationsApplied } from "../database/migrations-applied.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface CompactWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `compact_jobs` migrated before starting. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's Track-2 executor (narrow dynamic import by default). */
  readonly startExecutor: () => Promise<CompactJobsExecutorHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartExecutor(): Promise<CompactJobsExecutorHandle> {
  // Narrow import (not the `engine/index.js` barrel) — main may reach into
  // engine, and keeping it narrow avoids pulling the full runner graph.
  const { startCompactJobsExecutor } = await import(
    "@vex-agent/engine/compact-jobs/executor.js"
  );
  return startCompactJobsExecutor();
}

/**
 * Start the supervised Track-2 worker. Returns an idempotent async `stop`
 * for the ordered quit cleanup. Deps are injectable for tests; production
 * uses the real DB-url helper, schema probe, and narrow executor import.
 */
export function setupCompactWorker(
  deps: Partial<CompactWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeCompactJobsReady;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;

  let stopped = false;
  let started = false;
  let handle: CompactJobsExecutorHandle | null = null;
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
    log.info(`[compact-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(
      `compact-worker-supervisor-${randomUUID()}`,
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
      warnWaitingOnce("compact_jobs schema not ready");
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
    log.info("[compact-worker] Track-2 executor started");
  };

  const scheduleTick = (): void => {
    // Single in-flight tick: a slow tick must not be lapped by the interval
    // (that would orphan the earlier tick's promise from `stop()`).
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[compact-worker] supervisor tick failed", err);
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
    // Drain an in-flight startup tick first: it re-checks `stopped` after
    // each await and tears down any executor it managed to start.
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
