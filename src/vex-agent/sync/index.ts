/**
 * Sync module public API.
 *
 * initSync() — call on boot (after migrations).
 * syncTick() — call periodically from engine (every 60s).
 */

import { seedSyncJobs } from "./seed.js";
import { fullBalanceSync, type FullSyncResult } from "./balance-sync.js";
import { drainPendingRuns } from "./worker.js";
import * as syncRepo from "@vex-agent/db/repos/sync.js";
import logger from "@utils/logger.js";

/**
 * Initialize sync pipeline on boot.
 *
 * Order matters:
 * 1. Seed jobs (idempotent)
 * 2. Drain pending runs from previous process (selective, no snapshot)
 * 3. Full balance sync + authoritative startup snapshot
 */
export interface InitSyncOptions {
  /**
   * The RUNNING fast-lane registry's active-lane count, injected by the caller
   * that owns the handle (`startSyncExecutor`). It is what makes the re-arm
   * report lanes ACCEPTED rather than candidates emitted — the registry may
   * decline a candidate under its cap or its per-row dedup.
   */
  readonly activeLaneCount?: () => number;
}

export async function initSync(options: InitSyncOptions = {}): Promise<void> {
  logger.info("sync.init.starting");

  // 1. Seed default sync jobs
  await seedSyncJobs();

  // 2. Drain backlog from previous run (avoids double-snapshot)
  const backlog = await drainPendingRuns();
  if (backlog.processed > 0) {
    logger.info("sync.init.backlog_drained", { processed: backlog.processed });
  }

  // 3. Re-arm fast lanes for rows that were in flight when the process died.
  //    Before the snapshot: a crash-recovered row is exactly the kind the
  //    snapshot guard must see as still pending.
  try {
    const { rearmPendingFastLanes } = await import("./fast-lane.js");
    await rearmPendingFastLanes(options.activeLaneCount);
  } catch (err) {
    logger.warn("sync.init.fast_lane_rearm_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Authoritative startup full sync + snapshot
  try {
    const result = await fullBalanceSync({ snapshot: "always" });
    logger.info("sync.init.completed", {
      totalUsd: result.totalUsd.toFixed(2),
      wallets: result.wallets.length,
      snapshots: result.snapshots.length,
      snapshotGroupId: result.snapshotGroupId,
    });
  } catch (err) {
    logger.error("sync.init.balance_sync_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    // Don't throw — agent should still start even if balance sync fails
  }
}

/**
 * Periodic sync tick — called by engine every ~60s.
 *
 * 1. Drain any pending post-mutation runs
 * 2. Check if periodic jobs are due (balances, prediction_settlement, etc.)
 */
export async function syncTick(): Promise<void> {
  // 1. Drain post-mutation runs
  const drain = await drainPendingRuns();

  // 2. Check all periodic jobs
  const periodicJobs = (await syncRepo.getAllJobs()).filter(
    j => j.strategy === "periodic" && j.namespace === "_global",
  );

  for (const job of periodicJobs) {
    const intervalMs = (job.intervalSeconds ?? 300) * 1000;

    const lastRun = await syncRepo.getLastCompletedRun(job.id);
    const lastRunAge = lastRun?.endedAt
      ? Date.now() - new Date(lastRun.endedAt).getTime()
      : Infinity;

    if (lastRunAge <= intervalMs) continue;

    try {
      if (job.syncType === "balances") {
        const result = await fullBalanceSync({ snapshot: "when-settled" });
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(runId, { periodic: true, totalUsd: result.totalUsd }, result.wallets.reduce((s, w) => s + w.tokensUpdated, 0));
      } else if (job.syncType === "prediction_settlement") {
        const { reconcilePredictionSettlements } = await import("./prediction-settlement-sync.js");
        const settlementResult = await reconcilePredictionSettlements();
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(runId, { ...settlementResult }, settlementResult.closed);
      } else if (job.syncType === "agent_activity_repair") {
        const { repairPendingActivity, buildProductionRepairDeps } = await import("./agent-activity-repair.js");
        const repairResult = await repairPendingActivity(buildProductionRepairDeps());
        // STAGE F, on the same driver: a row this sweep (or a handler) confirmed
        // STATUS-ONLY still owes the user its executed amounts. Same job, because
        // it is the same question one step later — "did it settle" and "what did
        // it settle for" — and a separate job type would need its own seed row to
        // do the identical work at the identical cadence.
        const { repairMissingExecutedAmounts, buildProductionAmountFallbackDeps } =
          await import("./executed-amount-fallback.js");
        const amountResult = await repairMissingExecutedAmounts(
          buildProductionAmountFallbackDeps(),
        );
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(
          runId,
          { ...repairResult, amounts: { ...amountResult }, periodic: true },
          repairResult.confirmed + repairResult.failed + amountResult.filled,
        );
      } else if (job.syncType === "bridge_activity_repair") {
        // C1 fix (Batch 4 closure) — this periodic job was seeded (seed.ts)
        // and dispatched on-demand (worker.ts's drainPendingRuns/processNextRun)
        // but never had a syncTick() branch, so its own 120s periodic timer
        // never actually fired it. Mirrors the "agent_activity_repair" branch
        // above exactly.
        const { repairPendingBridges, buildProductionBridgeRepairDeps } = await import("./bridge-activity-repair.js");
        const bridgeResult = await repairPendingBridges(buildProductionBridgeRepairDeps());
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(
          runId,
          { ...bridgeResult, periodic: true },
          bridgeResult.confirmed + bridgeResult.failed,
        );
      } else if (job.syncType === "solana_activity_repair") {
        // W5 (migration 049, K3) — periodic driver for the Solana activity
        // sweep, mirroring the "agent_activity_repair" branch above exactly.
        const { repairPendingSolanaActivity, buildProductionSolanaRepairDeps } = await import("./solana-activity-repair.js");
        const solanaResult = await repairPendingSolanaActivity(buildProductionSolanaRepairDeps());
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(
          runId,
          { ...solanaResult, periodic: true },
          solanaResult.confirmed + solanaResult.failed,
        );
      } else if (job.syncType === "launch_identity_repair") {
        // Trench launch identity sweep — seeded (seed.ts) and dispatched by
        // worker.ts; this is its periodic driver, mirroring the branch above
        // exactly. Omitting it is the C1 defect the bridge sweep already hit:
        // the job's own timer fires nothing and the omission is silent.
        const { repairLaunchIdentities, buildProductionLaunchRepairDeps } = await import("./launch-identity-repair.js");
        const launchResult = await repairLaunchIdentities(buildProductionLaunchRepairDeps());
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(
          runId,
          { ...launchResult, periodic: true },
          launchResult.repaired + launchResult.failed,
        );
      } else if (job.syncType === "launch_form_expiry") {
        const { expireOverdueLaunchForms } = await import("./launch-form-expiry.js");
        const expiryResult = await expireOverdueLaunchForms();
        const runId = await syncRepo.enqueueRun(job.id);
        await syncRepo.completeRun(runId, { ...expiryResult, periodic: true }, expiryResult.expired);
      } else {
        logger.debug("sync.tick.unknown_periodic", { syncType: job.syncType });
      }
    } catch (err) {
      logger.warn("sync.tick.periodic_failed", {
        syncType: job.syncType,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * The user-initiated portfolio refresh (Wave P).
 *
 * `snapshot: "always"`: a user pressing refresh means "record what is true right
 * now", the same authoritative intent as the startup snapshot.
 *
 * SINGLE-FLIGHT NOW LIVES AT THE `fullBalanceSync` BOUNDARY ITSELF
 * (`balance-sync/single-flight.ts`), not here. A mutex on this function alone
 * guarded exactly one of five callers: startup, the periodic `balances` job and
 * both sync-worker branches called `fullBalanceSync` directly, so a manual
 * refresh could still overlap a background run and mint a second competing
 * snapshot group. Because `"always"` may not adopt a `"when-settled"` run's
 * possibly-suppressed snapshot, this caller QUEUES behind such a run rather than
 * joining it — see that module's doc.
 */
export async function refreshPortfolioNow(): Promise<FullSyncResult> {
  return fullBalanceSync({ snapshot: "always" });
}

export type { FullSyncResult } from "./balance-sync.js";
export { fullBalanceSync, selectiveBalanceSync } from "./balance-sync.js";
export { drainPendingRuns } from "./worker.js";
export { seedSyncJobs } from "./seed.js";
