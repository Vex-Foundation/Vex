/**
 * Compaction-preparation worker ownership (compaction v2).
 *
 * Electron main owns the engine's two preparation branch loops so forked
 * preparations actually produce a summary and land their memory chunks —
 * without this they sit `preparing` forever and no cutover ever becomes
 * available. Structurally identical to `compact-worker.ts`, and deliberately
 * so: same DB-readiness gate, same start-exactly-once discipline, same
 * non-reentrant `stop()` sequenced ahead of Postgres teardown by
 * `makeOrderedQuitCleanup`, so an in-flight branch drains against a live DB.
 *
 * Two independent gates keep it safe:
 *   - the executor's OWN pre-claim provider gate keeps both loops idle (no DB
 *     claim, no OpenRouter egress) until the vault injects
 *     `OPENROUTER_API_KEY` / `AGENT_MODEL`;
 *   - this supervisor only STARTS the executor once Postgres and the
 *     `compaction_preparations` schema are actually ready.
 *
 * READINESS PROBE. Owned by `main/database/compaction-preparation-db.ts`
 * (`probeCompactionPreparationsReady`) — one probe, one owner, deliberately
 * NOT a second probe bolted onto `compaction-db.ts`. It still fails closed on
 * any failure (config absent, connect error, migration 058 unapplied), so the
 * branch loops stay idle rather than claiming against a table nobody proved
 * exists.
 */

import { randomUUID } from "node:crypto";
import type { CompactionPreparationWorkerHandle } from "@vex-agent/engine/compaction/preparation-executor.js";
import { probeCompactionPreparationsReady } from "../database/compaction-preparation-db.js";
import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { migrationsApplied } from "../database/migrations-applied.js";

const SUPERVISOR_INTERVAL_MS = 30_000;

export interface CompactionPreparationWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates start. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `compaction_preparations` migrated. */
  readonly probeReady: () => Promise<boolean>;
  /** Start the engine's preparation branch loops. */
  readonly startExecutor: () => Promise<CompactionPreparationWorkerHandle>;
  /** Supervisor poll cadence (test override). */
  readonly intervalMs: number;
}

async function defaultStartExecutor(): Promise<CompactionPreparationWorkerHandle> {
  // Narrow import (not the `engine/index.js` barrel) — main may reach into
  // engine, and keeping it narrow avoids pulling the full runner graph.
  const { startCompactionPreparationWorkers } = await import(
    "@vex-agent/engine/compaction/preparation-executor.js"
  );
  return startCompactionPreparationWorkers();
}

/**
 * Start the supervised preparation worker. Returns an idempotent async `stop`
 * for the ordered quit cleanup. Deps are injectable for tests.
 */
export function setupCompactionPreparationWorker(
  deps: Partial<CompactionPreparationWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeCompactionPreparationsReady;
  const startExecutor = deps.startExecutor ?? defaultStartExecutor;

  let stopped = false;
  let started = false;
  let handle: CompactionPreparationWorkerHandle | null = null;
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
    log.info(`[compaction-prep-worker] waiting to start: ${reason}`);
  };

  const tick = async (): Promise<void> => {
    if (stopped || started) return;

    const dbUrl = await ensureDbUrl(
      `compaction-prep-worker-supervisor-${randomUUID()}`,
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
      warnWaitingOnce("compaction_preparations schema not ready");
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
    log.info("[compaction-prep-worker] preparation branch loops started");
  };

  const scheduleTick = (): void => {
    // Single in-flight tick: a slow tick must not be lapped by the interval
    // (that would orphan the earlier tick's promise from `stop()`).
    if (stopped || started || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        log.warn("[compaction-prep-worker] supervisor tick failed", err);
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
