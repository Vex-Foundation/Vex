/**
 * Regime worker ownership (S6b §9).
 *
 * Electron main owns the engine's daily regime worker so `regime_snapshots`
 * actually accrues one classification a day — without this, regime-aware decay
 * permanently degrades to pure time decay. Enabled by default; three
 * independent gates keep it safe:
 *   - the worker's OWN per-tick env gates keep it a no-op (no network egress,
 *     no LLM call) until the vault injects OPENROUTER_API_KEY + AGENT_MODEL and
 *     at least one source key (TAVILY_API_KEY / RETTIWT_API_KEY);
 *   - the worker's cadence gate makes the effective rhythm daily;
 *   - this supervisor only STARTS the worker once Postgres + the
 *     `regime_snapshots` schema are actually ready (not merely once
 *     `VEX_DB_URL` resolves). It deliberately does NOT wait for vault unlock —
 *     that is the per-tick env gate's job.
 *
 * Lifecycle mirrors `memory-manager-worker.ts`: tick immediately then every
 * `SUPERVISOR_INTERVAL_MS` until the DB is ready, then start the worker EXACTLY
 * ONCE and clear the interval (the worker self-schedules thereafter). `stop()`
 * is non-reentrant and idempotent: clears the interval, awaits any in-flight
 * startup tick, and stops the worker if started — a probe/import that resolves
 * AFTER quit begins must NOT leave a live worker.
 *
 * `stop()` is sequenced BEFORE compose/Postgres teardown via
 * `makeOrderedQuitCleanup` in `index.ts`, so an in-flight classification drains
 * against a live DB.
 */

import { randomUUID } from "node:crypto";
import type { RegimeWorkerHandle } from "@vex-agent/engine/regime/regime-worker.js";
import { log } from "../logger/index.js";
import { probeRegimeSnapshotsReady } from "../database/regime-db.js";
import { ensureEngineDbUrl } from "../ipc/runtime/_ensure-engine-db-url.js";
import { migrationsApplied } from "../database/migrations-applied.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface RegimeWorkerSupervisorDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `regime_snapshots` migrated before starting. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's regime worker (narrow dynamic import by default). */
  readonly startWorker: () => Promise<RegimeWorkerHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartWorker(): Promise<RegimeWorkerHandle> {
  // Narrow import (not the `engine/index.js` barrel) to avoid pulling the full
  // runner graph into the supervisor's import chain.
  const { startRegimeWorker } = await import(
    "@vex-agent/engine/regime/regime-worker.js"
  );
  return startRegimeWorker();
}

/**
 * Start the supervised regime worker. Returns an idempotent async `stop` for
 * the ordered quit cleanup. Deps are injectable for tests; production uses the
 * real DB-url helper, schema probe, and narrow worker import.
 */
export function setupRegimeWorker(
  deps: Partial<RegimeWorkerSupervisorDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeRegimeSnapshotsReady;
  const startWorker = deps.startWorker ?? defaultStartWorker;

  let stopped = false;
  let started = false;
  let handle: RegimeWorkerHandle | null = null;
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
    log.info(`[regime-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(
      `regime-worker-supervisor-${randomUUID()}`,
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
      warnWaitingOnce("regime_snapshots schema not ready");
      return;
    }

    const live = await startWorker();
    started = true;
    clearTimer();
    // stop() may have raced in during `startWorker`'s await — if so, tear down
    // the worker we just created so quit never leaves a live worker.
    if (stopped) {
      await live.stop();
      return;
    }
    handle = live;
    log.info("[regime-worker] regime worker started");
  };

  const scheduleTick = (): void => {
    // Single in-flight tick: a slow tick must not be lapped by the interval
    // (that would orphan the earlier tick's promise from `stop()`).
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[regime-worker] supervisor tick failed", err);
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
    // await and tears down any worker it managed to start.
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
