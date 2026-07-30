/**
 * Compaction-preparation worker entry point — TWO independent poll loops.
 *
 * WHY A NEW EXECUTOR AND NOT AN EXTENSION OF `compact-jobs/executor.ts`:
 *   - that loop claims a whole `compact_jobs` row under ONE lease, and every
 *     one of its helpers (`claimNextDueJob` → `locked_by` → `heartbeat` →
 *     `markCompleted`/`markFailed`) is owner-checked against that single lease.
 *     The preparation design mandates two INDEPENDENT per-branch leases with
 *     separate attempt budgets and lifetimes, which is structurally
 *     incompatible with a single-lease claim;
 *   - contract C5 requires the legacy `compact_jobs` chunker to survive
 *     UNCHANGED as the deterministic-fallback path. Extending its executor is
 *     the one thing that contract forbids.
 *   - the repo already has this exact precedent: `memory-manager/executor.ts`
 *     mirrors the compact-jobs loop's discipline while running its own table.
 *
 * WHY TWO LOOPS AND NOT ONE TICK DOING BOTH BRANCHES: a branch-A attempt can
 * occupy 90 seconds, and a shared tick would serialize branch B behind it —
 * which is precisely the fork the design exists to create. They also poll at
 * deliberately DIFFERENT intervals with jitter: a claim takes a ROW lock, so
 * two perfectly-synchronised loops would make cross-branch claim collisions
 * (harmless, but a wasted poll) the common case instead of the rare one.
 */

import { randomUUID } from "node:crypto";

import {
  APPLY_STALE_THRESHOLD_MS,
  BRANCH_STALE_THRESHOLD_MS,
  recoverStaleBranch,
  recoverStuckApplying,
} from "../../db/repos/compaction-preparations/index.js";
import logger from "@utils/logger.js";

import { runChunksBranchTick } from "./branch-b-chunks-worker.js";
import { runSummaryBranchTick } from "./branch-a-summary-worker.js";
import type { BranchProviderFactory } from "./branch-provider-call.js";
import {
  CHUNKS_POLL_INTERVAL_MS,
  SUMMARY_POLL_INTERVAL_MS,
  nextPollDelayMs,
} from "./policy.js";

export interface CompactionPreparationWorkerHandle {
  stop: () => Promise<void>;
}

export interface StartPreparationWorkersOptions {
  readonly summaryPollIntervalMs?: number;
  readonly chunksPollIntervalMs?: number;
  /** Test seam — production uses the per-call vault provider factory. */
  readonly makeProvider?: BranchProviderFactory;
}

export function startCompactionPreparationWorkers(
  options: StartPreparationWorkersOptions = {},
): CompactionPreparationWorkerHandle {
  const suffix = `${process.pid}-${randomUUID().slice(0, 8)}`;
  // Distinct ids per branch so lease ownership is never ambiguous in the row
  // or in a log line.
  const summaryWorkerId = `compaction-summary-${suffix}`;
  const chunksWorkerId = `compaction-chunks-${suffix}`;
  let stopped = false;

  // Bootstrap stale recovery for app-crash leftovers. Non-fatal: a DB failure
  // here just means the next poll retries, but the rejection must not reach
  // Node's unhandledRejection trap.
  //
  // The APPLY sweep is the crash-window backstop: an `applying` row whose owner
  // died on either side of Tx B's COMMIT. It is resolved by
  // `recoverStuckApplying`'s discriminator (a still-`applying` row proves Tx B
  // did NOT commit, so a spent target generation is a CONFLICT, never proof of
  // success). The AUTHORITATIVE guarantee is per-session and awaited at the
  // iteration boundary — see `compaction/apply/consume-at-boundary.ts`; a
  // session about to compact recovers its own stale row before consuming.
  // This sweep only catches sessions that may never run again.
  void recoverStuckApplying(APPLY_STALE_THRESHOLD_MS)
    .then((result) => {
      if (result.conflictedTerminal > 0 || result.restoredToRequested > 0) {
        logger.info("compaction-prep.stale_apply_recovered", {
          conflictedTerminal: result.conflictedTerminal,
          restoredToRequested: result.restoredToRequested,
        });
      }
    })
    .catch((err) => {
      logger.warn("compaction-prep.stale_apply_recovery_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });

  for (const branch of ["summary", "chunks"] as const) {
    void recoverStaleBranch(branch, BRANCH_STALE_THRESHOLD_MS)
      .then((count) => {
        if (count > 0) {
          logger.info("compaction-prep.stale_recovered", { branch, count });
        }
      })
      .catch((err) => {
        logger.warn("compaction-prep.stale_recovery_failed", {
          branch,
          error: err instanceof Error ? err.message : String(err),
        });
      });
  }

  const loop = (
    name: string,
    baseIntervalMs: number,
    tick: () => Promise<unknown>,
  ): { stop: () => Promise<void> } => {
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> | null = null;

    const schedule = (): void => {
      if (stopped) return;
      inFlight = tick()
        .then(() => undefined)
        .catch((err) => {
          logger.error("compaction-prep.tick_failed", {
            loop: name,
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          inFlight = null;
          if (!stopped) {
            timer = setTimeout(schedule, nextPollDelayMs(baseIntervalMs));
          }
        });
    };
    schedule();

    return {
      async stop(): Promise<void> {
        if (timer) clearTimeout(timer);
        if (inFlight) await inFlight;
      },
    };
  };

  const summaryLoop = loop(
    "summary",
    options.summaryPollIntervalMs ?? SUMMARY_POLL_INTERVAL_MS,
    () =>
      runSummaryBranchTick(summaryWorkerId, {
        ...(options.makeProvider ? { makeProvider: options.makeProvider } : {}),
      }),
  );
  const chunksLoop = loop(
    "chunks",
    options.chunksPollIntervalMs ?? CHUNKS_POLL_INTERVAL_MS,
    () =>
      runChunksBranchTick(chunksWorkerId, {
        ...(options.makeProvider ? { makeProvider: options.makeProvider } : {}),
      }),
  );

  return {
    async stop(): Promise<void> {
      stopped = true;
      await Promise.all([summaryLoop.stop(), chunksLoop.stop()]);
    },
  };
}
