/**
 * Tool-embedding reconcile worker ownership (T0.5).
 *
 * Electron main owns the boot-time refresh of `tool_embeddings` so packaged
 * users get dense tool discovery that stays consistent with the tool manifests
 * shipped in each app update — without this, `reconcileToolEmbeddings()` only
 * ever runs from the dev `pnpm tool-reembed` script and packaged installs drift
 * (manifest changes never re-embed; removed/renamed tool ids linger as orphans).
 *
 * Unlike the compact/wake/sync/regime workers this supervisor does NOT start a
 * long-lived self-scheduling executor. It performs a finite reconcile itself
 * and then goes dormant. Lifecycle:
 *   - gate (shared with the other supervisors): ensureEngineDbUrl + a cheap
 *     `tool_embeddings` table probe. While the DB url or schema is not ready the
 *     worker just waits and re-ticks at the base interval — this is NOT a
 *     reconcile attempt and never counts toward the cap (mirrors the other
 *     supervisors' "waiting to start" state);
 *   - once the gate passes it runs one reconcile pass:
 *       · completes with `errors === 0` ⇒ success ⇒ dormant (stop ticking);
 *       · completes with `errors > 0` ⇒ per-tool failures; retry next tick with
 *         backoff, CAP at MAX_ATTEMPTS reconcile passes per boot, then dormant
 *         with a warning;
 *       · throws (infra/config: provider down, config missing, DB dropped) ⇒
 *         warning log + retry next tick with backoff under the same cap.
 *   - `stop()` is non-reentrant and idempotent: sets `stopped`, clears the
 *     pending timer, and awaits any in-flight tick — a reconcile that resolves
 *     AFTER quit begins must not reschedule.
 *
 * Never blocks startup/onboarding: `setup...` returns synchronously and the
 * first tick is fire-and-forget. `stop()` is sequenced into `globalCleanup`
 * alongside the other workers.
 *
 * `reconcileToolEmbeddings` is imported via the main-only `@vex-agent` alias.
 */

import { randomUUID } from "node:crypto";
import type { ReconcileReport } from "@vex-agent/tools/protocols/embeddings/reembed.js";
import { log } from "../logger/index.js";
import { probeToolEmbeddingsReady } from "../database/tool-embeddings-db.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { migrationsApplied } from "../database/migrations-applied.js";

/** Base supervisor cadence (gate wait + first retry delay). */
const SUPERVISOR_INTERVAL_MS = 30_000;
/** Backoff ceiling — a run of failing passes never waits longer than this. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** Reconcile passes attempted per boot before giving up and going dormant. */
const MAX_ATTEMPTS = 5;

export interface ToolEmbeddingReconcileWorkerDeps {
  /** Point the engine pool at local Postgres; `{ ok }` gates the pass. */
  readonly ensureDbUrl: (
    correlationId: string,
  ) => Promise<{ readonly ok: boolean }>;
  /** Prove Postgres reachable + `tool_embeddings` migrated before reconciling. */
  readonly probeReady: () => Promise<boolean>;
  /** Run one reconcile pass (narrow dynamic import by default). */
  readonly reconcile: () => Promise<ReconcileReport>;
  /** Base poll cadence + first retry delay (test override). */
  readonly intervalMs: number;
  /** Backoff ceiling (test override). */
  readonly maxBackoffMs: number;
}

async function defaultReconcile(): Promise<ReconcileReport> {
  // Narrow import (not a barrel) to avoid pulling unrelated engine graph into
  // the supervisor's import chain.
  const { reconcileToolEmbeddings } = await import(
    "@vex-agent/tools/protocols/embeddings/reembed.js"
  );
  return reconcileToolEmbeddings();
}

/**
 * Capped exponential backoff between failing reconcile passes.
 * `failedAttempts` is 1 for the first retry, 2 for the second, …
 */
function backoffMs(base: number, max: number, failedAttempts: number): number {
  return Math.min(base * 2 ** (failedAttempts - 1), max);
}

/**
 * Start the tool-embedding reconcile worker. Returns an idempotent async `stop`
 * for the ordered quit cleanup. Deps are injectable for tests; production uses
 * the real DB-url helper, schema probe, and narrow reconcile import.
 */
export function setupToolEmbeddingReconcileWorker(
  deps: Partial<ToolEmbeddingReconcileWorkerDeps> = {},
): () => Promise<void> {
  const intervalMs = deps.intervalMs ?? SUPERVISOR_INTERVAL_MS;
  const maxBackoffMs = deps.maxBackoffMs ?? MAX_BACKOFF_MS;
  const ensureDbUrl =
    deps.ensureDbUrl ??
    ((correlationId: string) => ensureEngineDbUrl(correlationId));
  const probeReady = deps.probeReady ?? probeToolEmbeddingsReady;
  const reconcile = deps.reconcile ?? defaultReconcile;

  let stopped = false;
  let dormant = false; // reached a terminal state (success or attempt cap)
  let attempts = 0; // reconcile passes actually run (gate-passed) this boot
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightTick: Promise<void> | null = null;
  // One line per DISTINCT wait reason: a worker that waited on the DB url and
  // then on migrations must report both, not only whichever came first.
  const loggedWaitReasons = new Set<string>();

  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const warnWaitingOnce = (reason: string): void => {
    if (loggedWaitReasons.has(reason)) return;
    loggedWaitReasons.add(reason);
    log.info(`[tool-embedding-reconcile] waiting to start: ${reason}`);
  };

  const scheduleNext = (delayMs: number): void => {
    if (stopped || dormant) return;
    clearTimer();
    timer = setTimeout(runTick, delayMs);
  };

  const goDormant = (): void => {
    dormant = true;
    clearTimer();
  };

  const tick = async (): Promise<void> => {
    if (stopped || dormant) return;

    const dbUrl = await ensureDbUrl(
      `tool-embedding-reconcile-${randomUUID()}`,
    );
    if (stopped || dormant) return; // re-check after await
    if (!dbUrl.ok) {
      warnWaitingOnce("database url unavailable");
      scheduleNext(intervalMs); // gate wait — not an attempt, no cap
      return;
    }

    // Schema VERSION, not schema presence — see `database/migrations-applied.ts`.
    if (!migrationsApplied()) {
      warnWaitingOnce("migrations pending");
      scheduleNext(intervalMs); // gate wait — not an attempt, no cap
      return;
    }

    const ready = await probeReady();
    if (stopped || dormant) return; // re-check after await
    if (!ready) {
      warnWaitingOnce("tool_embeddings schema not ready");
      scheduleNext(intervalMs); // gate wait — not an attempt, no cap
      return;
    }

    // Gate passed — this counts as one reconcile attempt.
    try {
      const report = await reconcile();
      if (stopped || dormant) return;
      attempts++;
      if (report.errors === 0) {
        log.info("[tool-embedding-reconcile] reconcile complete", {
          embedded: report.embedded,
          skipped: report.skipped,
          deleted: report.deleted,
          durationMs: report.durationMs,
        });
        goDormant();
        return;
      }
      if (attempts >= MAX_ATTEMPTS) {
        log.warn(
          `[tool-embedding-reconcile] giving up after ${attempts} passes with per-tool errors (last: ${report.errors})`,
        );
        goDormant();
        return;
      }
      log.warn(
        `[tool-embedding-reconcile] pass ${attempts} had ${report.errors} per-tool error(s); retrying`,
      );
      scheduleNext(backoffMs(intervalMs, maxBackoffMs, attempts));
    } catch (err) {
      if (stopped || dormant) return;
      attempts++;
      log.warn("[tool-embedding-reconcile] reconcile pass failed", err);
      if (attempts >= MAX_ATTEMPTS) {
        log.warn(
          `[tool-embedding-reconcile] giving up after ${attempts} failed passes`,
        );
        goDormant();
        return;
      }
      scheduleNext(backoffMs(intervalMs, maxBackoffMs, attempts));
    }
  };

  function runTick(): void {
    // Single in-flight tick: a slow tick must not be lapped (that would orphan
    // the earlier tick's promise from `stop()` and double-run reconcile).
    if (stopped || dormant || inFlightTick !== null) return;
    inFlightTick = tick()
      .catch((err) => {
        // tick() handles its own reconcile/gate errors; this guards the
        // scheduling machinery only.
        log.warn("[tool-embedding-reconcile] supervisor tick failed", err);
      })
      .finally(() => {
        inFlightTick = null;
      });
  }

  // Immediate first tick (fast start when the DB is already up on relaunch).
  runTick();

  return async function stop(): Promise<void> {
    stopped = true;
    clearTimer();
    // Drain an in-flight tick: it re-checks `stopped` after each await and will
    // not reschedule once quit has begun.
    if (inFlightTick !== null) {
      try {
        await inFlightTick;
      } catch {
        // already logged in runTick
      }
    }
  };
}
