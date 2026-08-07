/**
 * Sync worker — claims pending runs, deduplicates, dispatches to handlers.
 *
 * Key behavior for balances: collects chain hints from execution_id → trade_capture,
 * merges into deduplicated set of { family, chainIds }, does minimal Khalani calls.
 */

import * as syncRepo from "@vex-agent/db/repos/sync.js";
import * as executionsRepo from "@vex-agent/db/repos/executions.js";
import { selectiveBalanceSync } from "./balance-sync.js";
import { resolveChainHint } from "./chains.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import { extractCauseCode } from "../../lib/error-cause.js";
import logger from "@utils/logger.js";

export interface DrainResult {
  processed: number;
  deduped: number;
  errors: number;
}

/**
 * Lease window for a `running` sync run. A run whose `started_at` (claim time)
 * is older than this is treated as an orphan from a crashed/killed process and
 * recovered before each drain. Comfortably larger than the worst-case real run
 * (settlement reconciliation paginates read APIs per wallet), so a healthy
 * in-flight run is never reclaimed. See B-005.
 */
const STALE_RUN_TIMEOUT_SECONDS = 600;

/**
 * Drain all pending sync runs with dedup.
 *
 * For balances: extracts chain hints from linked executions,
 * merges into per-family sets, does one Khalani call per family.
 */
export async function drainPendingRuns(): Promise<DrainResult> {
  // Recover orphaned `running` rows from a prior crash before claiming new work.
  // Stale rows are marked `failed` (not requeued) — the recovered work is not
  // idempotent across a partial-crash boundary; a fresh run re-derives state.
  try {
    const recovered = await syncRepo.recoverStaleRuns(STALE_RUN_TIMEOUT_SECONDS);
    if (recovered > 0) {
      logger.warn("sync.worker.stale_runs_recovered", {
        recovered,
        timeoutSeconds: STALE_RUN_TIMEOUT_SECONDS,
      });
    }
  } catch (err) {
    // Recovery is best-effort housekeeping — never block the drain on it.
    logger.warn("sync.worker.stale_recovery_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  const claimed = await syncRepo.claimAllPending();
  if (claimed.length === 0) return { processed: 0, deduped: 0, errors: 0 };

  // Group by syncType
  const byType = new Map<string, typeof claimed>();
  for (const run of claimed) {
    const job = await syncRepo.getJob(run.syncJobId);
    const syncType = job?.syncType ?? "unknown";
    const existing = byType.get(syncType) ?? [];
    existing.push(run);
    byType.set(syncType, existing);
  }

  let processed = 0;
  let deduped = 0;
  let errors = 0;

  for (const [syncType, runs] of byType) {
    deduped += Math.max(0, runs.length - 1);

    try {
      let result: Record<string, unknown>;
      let rowsAffected = 0;

      if (syncType === "balances") {
        // Extract chain hints from linked executions
        const chainHints = await collectChainHints(runs);

        if (chainHints.size === 0) {
          // No chain info — selective for both families without filter. Each
          // call now syncs every inventory wallet for that family (≤3).
          const evm = await selectiveBalanceSync("eip155");
          const sol = await selectiveBalanceSync("solana");
          const totalTokens = evm.tokensUpdated + sol.tokensUpdated;
          result = { selective: true, families: ["eip155", "solana"], tokensUpdated: totalTokens };
          rowsAffected = totalTokens;
        } else {
          // Selective sync per family with merged chainIds
          let totalTokens = 0;
          const families: string[] = [];
          for (const [family, chainIds] of chainHints) {
            const hint = chainIds.length > 0 ? chainIds.join(",") : family;
            const syncResult = await selectiveBalanceSync(hint);
            totalTokens += syncResult.tokensUpdated;
            families.push(family);
          }
          result = { selective: true, families, tokensUpdated: totalTokens };
          rowsAffected = totalTokens;
        }
      } else if (syncType === "prediction_settlement") {
        const { reconcilePredictionSettlements } = await import("./prediction-settlement-sync.js");
        const settlementResult = await reconcilePredictionSettlements();
        result = { ...settlementResult };
        rowsAffected = settlementResult.closed;
      } else if (syncType === "agent_activity_repair") {
        const { repairPendingActivity, buildProductionRepairDeps } = await import("./agent-activity-repair.js");
        const repairResult = await repairPendingActivity(buildProductionRepairDeps());
        result = { ...repairResult };
        rowsAffected = repairResult.confirmed + repairResult.failed;
      } else if (syncType === "bridge_activity_repair") {
        const { repairPendingBridges, buildProductionBridgeRepairDeps } = await import("./bridge-activity-repair.js");
        const bridgeResult = await repairPendingBridges(buildProductionBridgeRepairDeps());
        result = { ...bridgeResult };
        rowsAffected = bridgeResult.confirmed + bridgeResult.failed;
      } else if (syncType === "solana_activity_repair") {
        const { repairPendingSolanaActivity, buildProductionSolanaRepairDeps } = await import("./solana-activity-repair.js");
        const solanaResult = await repairPendingSolanaActivity(buildProductionSolanaRepairDeps());
        result = { ...solanaResult };
        rowsAffected = solanaResult.confirmed + solanaResult.failed;
      } else if (syncType === "launch_identity_repair") {
        // Trench launch crash recovery — completes the token IDENTITY of a
        // create that mined after the handler died, and terminalizes one that
        // is later proven to have reverted. The generic activity sweep cannot
        // do this: it is status-only and decodes nothing, so it would leave
        // `launched_tokens` empty forever. See sync/launch-identity-repair.ts.
        const { repairLaunchIdentities, buildProductionLaunchRepairDeps } = await import("./launch-identity-repair.js");
        const launchResult = await repairLaunchIdentities(buildProductionLaunchRepairDeps());
        result = { ...launchResult };
        rowsAffected = launchResult.repaired + launchResult.failed;
      } else if (syncType === "launch_attribution") {
        // Trench attribution retry lane — see sync/launch-attribution.ts. Keyless
        // POST only; holds no signer.
        const { attributeLaunchedTokens, buildProductionLaunchAttributionDeps } = await import("./launch-attribution.js");
        const attributionResult = await attributeLaunchedTokens(buildProductionLaunchAttributionDeps());
        result = { ...attributionResult };
        rowsAffected = attributionResult.attributed;
      } else if (syncType === "launch_form_expiry") {
        const { expireOverdueLaunchForms } = await import("./launch-form-expiry.js");
        const expiryResult = await expireOverdueLaunchForms();
        result = { ...expiryResult };
        rowsAffected = expiryResult.expired;
      } else if (syncType === "agentscan_report") {
        // AgentScan reporting lane — see sync/agentscan-report.ts. Keyless
        // telemetry POST only; never signs, never money-path.
        const { runAgentscanReport, buildProductionAgentscanReporterDeps } = await import("./agentscan-report.js");
        const reportResult = await runAgentscanReport(buildProductionAgentscanReporterDeps());
        result = { ...reportResult };
        rowsAffected = reportResult.sent;
      } else if (syncType === "agentscan_attest") {
        // AgentScan token-attestation sweep — see sync/agentscan-attest.ts.
        // Keyless telemetry POST only; never signs, never money-path.
        const { runAgentscanAttest, buildProductionAgentscanAttestDeps } = await import("./agentscan-attest.js");
        const attestResult = await runAgentscanAttest(buildProductionAgentscanAttestDeps());
        result = { ...attestResult };
        rowsAffected = attestResult.attested;
      } else if (syncType === "balances_snapshot") {
        // Wave P — a transaction terminalized, so take a fresh portfolio
        // snapshot now rather than at the next 300s periodic cycle.
        // `"when-settled"` re-checks the group-wide guard AT RUN TIME: if
        // another transaction is still in flight the snapshot re-defers and only
        // balances are refreshed, so a partial snapshot group is never emitted.
        const { fullBalanceSync } = await import("./balance-sync.js");
        const snapshotResult = await fullBalanceSync({ snapshot: "when-settled" });
        result = { snapshots: snapshotResult.snapshots.length, totalUsd: snapshotResult.totalUsd };
        rowsAffected = snapshotResult.snapshots.length;
      } else {
        result = { skipped: true, reason: `Unknown sync type: ${syncType}` };
        logger.warn("sync.worker.unknown_type", { syncType, runCount: runs.length });
      }

      for (const run of runs) {
        await syncRepo.completeRun(run.id, result, rowsAffected);
      }
      processed += runs.length;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Errno-shaped cause code (error-diagnostics phase) — the actionable
      // environment fact (TLS/DNS/connect) is often buried in `.cause`.
      const causeCode = extractCauseCode(err);
      logger.error("sync.worker.failed", {
        syncType,
        runCount: runs.length,
        error: msg,
        ...(causeCode !== null ? { causeCode } : {}),
      });

      const persistedMsg = causeCode !== null ? `${msg} (${causeCode})` : msg;
      for (const run of runs) {
        await syncRepo.failRun(run.id, persistedMsg);
      }
      errors += runs.length;
    }
  }

  if (processed > 0 || errors > 0) {
    logger.info("sync.worker.drain_completed", { processed, deduped, errors });
  }

  return { processed, deduped, errors };
}

/**
 * Process a single pending run — derives chain from execution.
 */
export async function processNextRun(): Promise<boolean> {
  const run = await syncRepo.claimPendingRun();
  if (!run) return false;

  const job = await syncRepo.getJob(run.syncJobId);
  if (!job) {
    await syncRepo.failRun(run.id, `Sync job ${run.syncJobId} not found`);
    return true;
  }

  try {
    if (job.syncType === "balances") {
      // Derive chain hint from execution
      const chainHint = await getChainHintFromExecution(run.executionId);
      const syncResult = await selectiveBalanceSync(chainHint);
      await syncRepo.completeRun(run.id, { ...syncResult }, syncResult.tokensUpdated);
    } else if (job.syncType === "prediction_settlement") {
      const { reconcilePredictionSettlements } = await import("./prediction-settlement-sync.js");
      const settlementResult = await reconcilePredictionSettlements();
      await syncRepo.completeRun(run.id, { ...settlementResult }, settlementResult.closed);
    } else if (job.syncType === "agent_activity_repair") {
      const { repairPendingActivity, buildProductionRepairDeps } = await import("./agent-activity-repair.js");
      const repairResult = await repairPendingActivity(buildProductionRepairDeps());
      await syncRepo.completeRun(run.id, { ...repairResult }, repairResult.confirmed + repairResult.failed);
    } else if (job.syncType === "bridge_activity_repair") {
      const { repairPendingBridges, buildProductionBridgeRepairDeps } = await import("./bridge-activity-repair.js");
      const bridgeResult = await repairPendingBridges(buildProductionBridgeRepairDeps());
      await syncRepo.completeRun(run.id, { ...bridgeResult }, bridgeResult.confirmed + bridgeResult.failed);
    } else if (job.syncType === "solana_activity_repair") {
      const { repairPendingSolanaActivity, buildProductionSolanaRepairDeps } = await import("./solana-activity-repair.js");
      const solanaResult = await repairPendingSolanaActivity(buildProductionSolanaRepairDeps());
      await syncRepo.completeRun(run.id, { ...solanaResult }, solanaResult.confirmed + solanaResult.failed);
    } else if (job.syncType === "launch_identity_repair") {
      const { repairLaunchIdentities, buildProductionLaunchRepairDeps } = await import("./launch-identity-repair.js");
      const launchResult = await repairLaunchIdentities(buildProductionLaunchRepairDeps());
      await syncRepo.completeRun(run.id, { ...launchResult }, launchResult.repaired + launchResult.failed);
    } else if (job.syncType === "launch_attribution") {
      const { attributeLaunchedTokens, buildProductionLaunchAttributionDeps } = await import("./launch-attribution.js");
      const attributionResult = await attributeLaunchedTokens(buildProductionLaunchAttributionDeps());
      await syncRepo.completeRun(run.id, { ...attributionResult }, attributionResult.attributed);
    } else if (job.syncType === "launch_form_expiry") {
      const { expireOverdueLaunchForms } = await import("./launch-form-expiry.js");
      const expiryResult = await expireOverdueLaunchForms();
      await syncRepo.completeRun(run.id, { ...expiryResult }, expiryResult.expired);
    } else if (job.syncType === "agentscan_report") {
      // AgentScan reporting lane — BOTH dispatchers need this branch; the
      // bridge job shipped with one missing and its timer silently fired
      // nothing for weeks. See sync/agentscan-report.ts.
      const { runAgentscanReport, buildProductionAgentscanReporterDeps } = await import("./agentscan-report.js");
      const reportResult = await runAgentscanReport(buildProductionAgentscanReporterDeps());
      await syncRepo.completeRun(run.id, { ...reportResult }, reportResult.sent);
    } else if (job.syncType === "agentscan_attest") {
      // AgentScan token-attestation sweep — BOTH dispatchers need this
      // branch, for the same reason. See sync/agentscan-attest.ts.
      const { runAgentscanAttest, buildProductionAgentscanAttestDeps } = await import("./agentscan-attest.js");
      const attestResult = await runAgentscanAttest(buildProductionAgentscanAttestDeps());
      await syncRepo.completeRun(run.id, { ...attestResult }, attestResult.attested);
    } else if (job.syncType === "balances_snapshot") {
      // Wave P — see the same branch in `drainPendingRuns` above. BOTH
      // dispatchers need it: the bridge job shipped with a branch missing from
      // one of them and its own timer silently fired nothing for weeks.
      const { fullBalanceSync } = await import("./balance-sync.js");
      const snapshotResult = await fullBalanceSync({ snapshot: "when-settled" });
      await syncRepo.completeRun(
        run.id,
        { snapshots: snapshotResult.snapshots.length, totalUsd: snapshotResult.totalUsd },
        snapshotResult.snapshots.length,
      );
    } else {
      await syncRepo.completeRun(run.id, { skipped: true, reason: `Unknown: ${job.syncType}` }, 0);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Suffix the errno-shaped cause code so the persisted failure reason
    // carries the environment fact (no schema change; no new log event).
    const causeCode = extractCauseCode(err);
    await syncRepo.failRun(run.id, causeCode !== null ? `${msg} (${causeCode})` : msg);
  }

  return true;
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Collect chain hints from all runs' linked executions.
 * Returns merged map of family → Set<chainId>.
 */
async function collectChainHints(
  runs: syncRepo.SyncRun[],
): Promise<Map<ChainFamily, number[]>> {
  const familyChains = new Map<ChainFamily, Set<number>>();

  for (const run of runs) {
    if (!run.executionId) continue;
    const execution = await executionsRepo.getById(run.executionId);
    if (!execution) continue;

    // Extract chain from trade_capture or external_refs
    const chain = (execution.tradeCapture as Record<string, unknown> | null)?.chain as string | undefined;
    if (!chain) continue;

    try {
      const resolved = await resolveChainHint(chain);
      const existing = familyChains.get(resolved.family) ?? new Set<number>();
      for (const id of resolved.chainIds) existing.add(id);
      familyChains.set(resolved.family, existing);
    } catch {
      // Skip unresolvable hints
    }
  }

  const result = new Map<ChainFamily, number[]>();
  for (const [family, chainSet] of familyChains) {
    result.set(family, [...chainSet]);
  }
  return result;
}

/**
 * Get chain hint string from a single execution's trade_capture.
 * Falls back to "eip155" if no chain info available.
 */
async function getChainHintFromExecution(executionId: number | null): Promise<string> {
  if (!executionId) return "eip155";
  const execution = await executionsRepo.getById(executionId);
  if (!execution) return "eip155";
  const chain = (execution.tradeCapture as Record<string, unknown> | null)?.chain as string | undefined;
  return chain ?? "eip155";
}
