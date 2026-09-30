/**
 * Wake executor — single-process scheduler that drives `LoopDefer` wakes.
 *
 * Contract:
 *   - Exactly ONE process runs the executor per deployment. Race safety
 *     across ticks does not depend on that: every row is claimed under the
 *     session control lock with a locked revalidation, so two concurrent ticks
 *     can list the same row and still start it at most once.
 *   - The desktop-agent host should start one process-local executor with
 *     hardcoded defaults (interval=2000ms, batchSize=10) after DB bootstrap.
 *     Wake is an installed-runtime concern, not a renderer concern.
 *
 * Tick semantics - both wake shapes are LISTED without consuming anything and
 * then claimed ONE AT A TIME, each claim followed by its run before the next:
 *   1a. MISSION-SCOPED: `claimMissionWake` consumes the row, flips the run
 *       `paused_wake → running` (or re-verifies an auto-retry) and takes the
 *       run/session lease as ONE transaction under the session control lock. A
 *       busy lease, or a run whose own turn loop has not parked yet, leaves the
 *       row pending with a bounded backoff; a run the wake can no longer resume
 *       has its row retired as `cancelled`.
 *   1b. SESSION-SCOPED: `claimSessionWake` revalidates the row, acquires the
 *       session lease and consumes the row as ONE transaction under the same
 *       lock.
 *   A crash between two claims therefore leaves every later row pending, and
 *   `consumed` always means "a runner started from this row".
 *   2.  Every outcome is reported on the returned `ClaimedWake` so tests and
 *       operators can see what the pass actually did.
 *   3.  The stuck-wake repair (`stuck-wake-repair.ts`) re-arms runs left in
 *       `paused_wake` with no pending row by the old batch claim.
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
 *   claimed.ts    - per-candidate claim + run (`handleClaimed`).
 *   agent-session.ts     — Full-Autonomous agent SESSION continuation.
 *   claim-session-wake.ts — the atomic session wake/lease claim + backoff.
 *   claim-mission-wake.ts - the atomic mission wake/run/lease claim,
 *                           including the auto-retry route.
 *   provider.ts   — `isWakeProviderConfigured`.
 *   pool.ts       - the concurrent pool, used only when
 *                   `AGENT_WAKE_CONCURRENCY` > 1: passes keep claiming while
 *                   slices run, never two slices of one session or of one
 *                   selected wallet at once.
 *   wallet-keys.ts - the wallet identities a slice can mutate.
 *
 * With the default concurrency of 1 the pool is never built and the executor
 * is exactly the serial `tick` chain described above.
 *
 * `startWakeExecutor` + `WakeExecutorHandle` + `StartOptions` stay here as the
 * self-scheduling lifecycle owner so the setTimeout chain, in-flight drain, and
 * stop() teardown remain in one place.
 */

import logger from "@utils/logger.js";

import { parseAgentWakeEnv } from "../../../lib/agent-config.js";
import { tick, type ClaimedWake } from "./executor/tick.js";
import { buildProductionDeps, type WakeDeps } from "./executor/deps.js";
import { createWakePool } from "./executor/pool.js";
import { sessionWalletKeys, type WalletKeysFor } from "./executor/wallet-keys.js";
import {
  startWakeWatchPromoter,
  type WakeWatchPromoterHandle,
} from "./watch-promoter.js";
import {
  startPriceWatchPoller,
  type PriceWatchPollerHandle,
} from "./price-watch-poller.js";
import {
  startRestartOrphanReclaim,
  type RestartOrphanReclaimHandle,
} from "../runtime/restart-orphan-reclaim.js";
import {
  startStuckWakeRepair,
  type StuckWakeRepairHandle,
} from "./stuck-wake-repair.js";

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
  /**
   * Price-watch poller override for tests. Same lifetime argument as the
   * promoter: it is the PULL half of the same mechanism, and a poller advancing
   * deadlines in a process with no executor to claim them is pure provider cost.
   */
  startPriceWatchPoller?: () => PriceWatchPollerHandle;
  /**
   * Restart-orphan reclaim override for tests. Same lifetime argument as the
   * two above, plus one of its own: the reclaim is the RECURRING sweep for runs
   * left `running` by a dead process, and the runner lease it waits on outlives
   * that process by its full TTL. A boot-only scan would see a live lease and
   * do nothing, so the sweep has to come back - and the host's supervisor timer
   * cannot carry it, because that timer is cleared the moment this executor
   * starts. This is the one process-local scheduler with the right lifetime:
   * started once, after the DB is proven ready, and drained on quit before
   * Postgres teardown.
   */
  startRestartOrphanReclaim?: () => RestartOrphanReclaimHandle;
  /**
   * Stuck-wake repair override for tests. It re-arms runs left `paused_wake`
   * with no pending wake by the old batch claim; the wake it writes is only
   * ever claimed by THIS executor, so its lifetime is bound to the executor's.
   */
  startStuckWakeRepair?: () => StuckWakeRepairHandle;
  /**
   * Most wake slices in flight at once. Defaults to the validated
   * `AGENT_WAKE_CONCURRENCY` (`src/lib/agent-config.ts`, default 1). `1` is
   * the serial executor, unchanged: one `tick` at a time, each claim followed
   * by its whole slice, then the interval. Above 1 the concurrent pool
   * (`./executor/pool.ts`) keeps claiming while slices run.
   */
  concurrency?: number;
  /** Wallet-key lookup override for tests (concurrent pool only). */
  walletKeysFor?: WalletKeysFor;
  /** Observer for each settled slice (concurrent pool only). Must not throw. */
  onSliceSettled?: (result: ClaimedWake) => void;
}

/**
 * The effective wake concurrency. An invalid value was already refused at
 * startup by `loadEnvConfig`; here it only falls back to the serial default,
 * logged by key and reason, never widened.
 */
function readWakeConcurrency(): number {
  const parsed = parseAgentWakeEnv(process.env);
  for (const error of parsed.errors) {
    logger.warn("wake.executor.concurrency_invalid_using_default", {
      key: error.key,
      reason: error.reason,
    });
  }
  return parsed.value.wakeConcurrency;
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
  // Checked before anything below starts, so a bad value leaves nothing running.
  const concurrency = options.concurrency ?? readWakeConcurrency();
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error("startWakeExecutor: concurrency must be a positive integer");
  }
  const promoter = (options.startWatchPromoter ?? startWakeWatchPromoter)();
  const pricePoller = (options.startPriceWatchPoller ?? (() => startPriceWatchPoller()))();
  const orphanReclaim = (
    options.startRestartOrphanReclaim ?? (() => startRestartOrphanReclaim())
  )();
  const stuckWakeRepair = (
    options.startStuckWakeRepair ?? (() => startStuckWakeRepair())
  )();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  // Concurrent pool, only above 1. At 1 it is never built and the serial
  // chain below runs exactly as before.
  const pool = concurrency > 1
    ? createWakePool({
        concurrency,
        limit,
        deps,
        walletKeysFor: options.walletKeysFor ?? sessionWalletKeys,
        onSettled: options.onSliceSettled,
      })
    : null;

  const runOne = async (): Promise<void> => {
    try {
      if (pool !== null) {
        // Awaits only the listing and the wallet lookups, never a slice.
        await pool.pass(now());
      } else {
        await tick(now(), limit, deps);
      }
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
  logger.info("wake.executor.started", {
    intervalMs: interval,
    batchSize: limit,
    concurrency,
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      promoter.stop();
      // The poller abandons its in-flight wait at once and promotes nothing.
      await pricePoller.stop();
      // Drains its in-flight pass; a reclaim transaction must finish against a
      // live DB, and quit sequences this stop() before Postgres teardown.
      await orphanReclaim.stop();
      // Same drain rule: a repair transaction finishes against a live DB.
      await stuckWakeRepair.stop();
      if (timer) clearTimeout(timer);
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged inside runOne — swallow so shutdown doesn't throw.
        }
      }
      // The concurrent pool's slices outlive the pass that started them, so
      // they are drained here, after the last pass: each ends on its own
      // lease release against a live DB, and no new slice can start.
      if (pool !== null) await pool.drain();
      logger.info("wake.executor.stopped");
    },
  };
}
