/**
 * Wake executor — single-process scheduler that drives `loop_defer` wakes.
 *
 * Contract:
 *   - Exactly ONE process runs the executor per deployment. Race safety
 *     across ticks is provided by `loopWakeRepo.claimDue` (FOR UPDATE SKIP
 *     LOCKED). Mission-run wake resumes also claim the run row with a CAS
 *     before injecting the wake banner, so `/retry` and wake cannot both
 *     resume the same stale `paused_wake` snapshot.
 *   - The desktop-agent host should start one process-local executor with
 *     hardcoded defaults (interval=2000ms, batchSize=10) after DB bootstrap.
 *     Wake is an installed-runtime concern, not a renderer concern.
 *
 * Tick semantics — TWO reads, because the two wake shapes are claimed
 * differently:
 *   1a. MISSION-SCOPED: `claimDue(now, batchSize)` atomically flips the
 *       pending rows to `consumed` and returns them. Rows the executor cannot
 *       handle (e.g. run status drifted to `running` because a user preempted)
 *       are SKIPPED but NOT unclaimed — the row is terminal once consumed, and
 *       the race is accepted (the user already resumed, so no banner is owed).
 *   1b. SESSION-SCOPED: `listDueSessionWakes` returns CANDIDATES without
 *       consuming anything. Each is then claimed by `claimSessionWake`, which
 *       revalidates the row, acquires the session lease and consumes the row as
 *       ONE transaction under the session control lock. A session has no run
 *       row to serve as backup evidence, so the destructive-first order would
 *       (and did) throw the continuation away on a busy lease — and left a
 *       window in which an operator Stop found nothing to stop.
 *   2.  Every outcome is reported on the returned `ClaimedWake` so tests and
 *       operators can see what the pass actually did.
 *
 * Post-M12 simplification: `full_autonomous` mode is gone. A wake row targets
 * either a mission run or a Full-Autonomous agent SESSION; the executor
 * branches on the row's own shape, never on a `wake.kind`.
 *
 * Structural split: this file is the compatibility façade + lifecycle owner.
 * The tick implementation lives under `./executor/`:
 *
 *   deps.ts       — `WakeDeps` + production default deps wiring.
 *   tick.ts       — `tick` + `ClaimedWake` / `ClaimedWakeOutcome`.
 *   claimed.ts    — normal claimed-job handling (`handleClaimed`).
 *   agent-session.ts     — Full-Autonomous agent SESSION continuation.
 *   claim-session-wake.ts — the atomic session wake/lease claim + backoff.
 *   auto-retry.ts — auto-retry handling (`handleAutoRetryClaimed`).
 *   provider.ts   — `isWakeProviderConfigured`.
 *
 * `startWakeExecutor` + `WakeExecutorHandle` + `StartOptions` stay here as the
 * self-scheduling lifecycle owner so the setTimeout chain, in-flight drain, and
 * stop() teardown remain in one place.
 */

import logger from "@utils/logger.js";

import { tick } from "./executor/tick.js";
import { buildProductionDeps, type WakeDeps } from "./executor/deps.js";
import {
  startWakeWatchPromoter,
  type WakeWatchPromoterHandle,
} from "./watch-promoter.js";

export type { ClaimedWakeOutcome, ClaimedWake } from "./executor/tick.js";
export { tick } from "./executor/tick.js";
export type { WakeDeps } from "./executor/deps.js";
export { isWakeProviderConfigured } from "./executor/provider.js";

// ── Scheduler ──────────────────────────────────────────────────────

export interface WakeExecutorHandle {
  /** Stop the executor. Resolves after the in-flight tick (if any) settles. */
  stop(): Promise<void>;
}

export interface StartOptions {
  intervalMs?: number;
  batchSize?: number;
  deps?: WakeDeps;
  now?: () => Date;
  /**
   * Watch-promoter override for tests. The promoter is the PUSH half of the
   * same mechanism this executor polls for, so its lifetime is bound to the
   * executor's rather than started separately by the host — a live promoter
   * with no executor would advance deadlines nothing would ever claim.
   */
  startWatchPromoter?: () => WakeWatchPromoterHandle;
}

/**
 * Start the executor's polling loop. Defaults: interval 2000ms, batch 10.
 * Defaults are hardcoded — no env-driven override — so a stale
 * `AGENT_WAKE_ENABLED=false` from an older install cannot disable wake.
 * Pass `deps`/`now` in tests to inject fakes without touching the real DB.
 *
 * `stop()` drains any currently-running tick before resolving, so hosts can
 * await a clean shutdown.
 */
export function startWakeExecutor(options: StartOptions = {}): WakeExecutorHandle {
  const interval = options.intervalMs ?? 2000;
  const limit = options.batchSize ?? 10;
  const now = options.now ?? (() => new Date());
  const deps = options.deps ?? buildProductionDeps();
  const promoter = (options.startWatchPromoter ?? startWakeWatchPromoter)();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const runOne = async (): Promise<void> => {
    try {
      await tick(now(), limit, deps);
    } catch (err) {
      logger.error("wake.executor.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = runOne().finally(() => {
      inFlight = null;
      if (!stopped) {
        timer = setTimeout(schedule, interval);
      }
    });
  };

  timer = setTimeout(schedule, interval);
  logger.info("wake.executor.started", { intervalMs: interval, batchSize: limit });

  return {
    async stop(): Promise<void> {
      stopped = true;
      promoter.stop();
      if (timer) clearTimeout(timer);
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged inside runOne — swallow so shutdown doesn't throw.
        }
      }
      logger.info("wake.executor.stopped");
    },
  };
}
