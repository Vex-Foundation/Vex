/**
 * memory_manager executor — async memory curator worker (S4 §5/§10).
 *
 * Mirrors `engine/compact-jobs/executor.ts`: a poll loop with idempotent
 * shutdown, bootstrap stale-recovery on start, a pre-claim provider-config gate,
 * and a heartbeat + claim-lost guard around each job. Runs on `memory_jobs` (NOT
 * compact_jobs — separate semantics). NO per-session mutex: a consolidate job
 * batches candidates from many sessions; `uniq_mji_active_candidate` +
 * `claimNextDueJob` FOR UPDATE SKIP LOCKED serialize.
 *
 * Per consolidate job (§5.3):
 *   reserveCandidatesForJob → for each reserved item, sequentially:
 *     - claim-lost guard between items;
 *     - idempotent-close: a non-pending candidate (decision committed but its
 *       markItemDone failed on a prior attempt) is closed via getLatestDecision,
 *       NEVER re-applied (no double-promote); a non-pending candidate with NO
 *       decision is corruption → markItemFailed;
 *     - else (pending): consolidateCandidate → plan → applyDecisionAtomically
 *       (owner-check + apply + recordDecision, ONE tx) → markItemDone AFTER commit;
 *     - transient error (LLM/DB/owner-loss) → markItemFailed (don't fail the
 *       whole job for one item).
 *   Finalize: anyTransientFailure || anyUnclosed → markFailed (retry revives the
 *   job's own failed/unclosed items); else markCompleted.
 *
 * The async `reconcile` job kind (S7) is retired (Agent Scan W4:
 * `engine/memory-manager/reconcile.ts` deleted, along with every caller that
 * could enqueue a fresh reconcile job). Migration 044 terminalized every
 * non-terminal reconcile row to a new `retired` status; this loop no longer
 * claims or dispatches `reconcile`-kind jobs — only `consolidate`.
 *
 * Maintenance cron-tick (§10): every MAINTENANCE_SWEEP_INTERVAL_MS, enqueue a
 * consolidate job IFF pending candidates exist without an active job.
 */

import { randomUUID } from "node:crypto";

import {
  claimNextDueJob,
  enqueueConsolidateJob,
  heartbeat,
  markCompleted,
  markFailed,
  recoverStaleRunning,
  bumpJobInference,
  listJobsByStatus,
  type MemoryJob,
} from "@vex-agent/db/repos/memory-jobs/index.js";
import {
  reserveCandidatesForJob,
  listItemsByJob,
  markItemProcessing,
  markItemDone,
  markItemFailed,
  type MemoryJobItem,
} from "@vex-agent/db/repos/memory-job-items/index.js";
import { getLatestDecision } from "@vex-agent/db/repos/memory-decisions/index.js";
import { listCandidatesByStatus } from "@vex-agent/db/repos/memory-candidates/index.js";
import { runDecaySweep } from "./decay-sweep.js";
import {
  consolidateCandidate,
  applyDecisionAtomically,
  defaultConsolidateDeps,
  getCandidateById,
  getCandidateEmbedding,
  type ConsolidateDeps,
} from "@vex-agent/memory/manager/index.js";
import { memLog } from "@vex-agent/memory/observability/logger.js";
import {
  CONSOLIDATE_BATCH_LIMIT,
  MAINTENANCE_SWEEP_INTERVAL_MS,
  MEMORY_RETRY_BACKOFF_BASE_MS,
  MEMORY_WORKER_POLL_INTERVAL_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_STALE_THRESHOLD_MS,
} from "./policy.js";

export interface MemoryManagerExecutorHandle {
  stop: () => Promise<void>;
}

export interface StartMemoryManagerOptions {
  /** Poll interval in ms. Default MEMORY_WORKER_POLL_INTERVAL_MS. */
  pollIntervalMs?: number;
  /** Maintenance sweep cadence in ms. Default MAINTENANCE_SWEEP_INTERVAL_MS. */
  sweepIntervalMs?: number;
  /** Injectable consolidate deps (tests stub recall/deref/judge). */
  deps?: ConsolidateDeps;
}

export function startMemoryManagerExecutor(
  options: StartMemoryManagerOptions = {},
): MemoryManagerExecutorHandle {
  const interval = options.pollIntervalMs ?? MEMORY_WORKER_POLL_INTERVAL_MS;
  const sweepInterval = options.sweepIntervalMs ?? MAINTENANCE_SWEEP_INTERVAL_MS;
  const workerId = `memory-manager-${process.pid}-${randomUUID().slice(0, 8)}`;
  const deps = options.deps ?? defaultConsolidateDeps();

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let warnedNoProviderConfig = false;

  // Bootstrap stale recovery (non-fatal; next tick retries claim).
  void recoverStaleRunning(WORKER_STALE_THRESHOLD_MS)
    .then((res) => {
      const n = res.jobsReset + res.jobsFailed;
      if (n > 0) memLog("manager", "stale_recovered", { count: n });
    })
    .catch((err) => {
      memLog.warn("manager", "stale_recovery_failed", {
        errorCode: err instanceof Error ? "stale_recovery_error" : "stale_recovery_unknown",
      });
    });

  const tick = async (): Promise<void> => {
    try {
      // Pre-claim provider-config gate — claim increments attempt_count, so
      // claiming then throwing on missing config would burn the retry budget.
      if (!process.env.OPENROUTER_API_KEY || !process.env.AGENT_MODEL) {
        if (!warnedNoProviderConfig) {
          memLog.warn("manager", "skipped", { errorCode: "no_provider_config" });
          warnedNoProviderConfig = true;
        }
        return;
      }
      warnedNoProviderConfig = false;

      const job = await claimNextDueJob(workerId);
      if (!job) return;
      memLog("manager", "claimed", { jobId: job.id, jobKind: job.jobKind });

      // C19 defense in depth: the claim query is consolidate-only by
      // predicate, but a claimed row of any OTHER kind (e.g. a legacy
      // `reconcile` row surfacing through a future query edit) must never be
      // processed as consolidation.
      if (job.jobKind !== "consolidate") {
        memLog.error("manager", "claimed_non_consolidate_job", { jobId: job.id });
        return;
      }

      await processConsolidateJob(job, workerId, deps);
    } catch (err) {
      memLog.error("manager", "tick_failed", {
        errorCode: err instanceof Error ? "tick_error" : "tick_unknown",
      });
    }
  };

  const sweep = async (): Promise<void> => {
    // S6a activation decay sweep — independent of the consolidate-enqueue check
    // below (decay must run even when there are no pending candidates). Its own
    // try/catch so a decay failure never blocks consolidate enqueue and vice
    // versa. Idempotent + bounded (see decay-sweep.ts).
    try {
      await runDecaySweep();
    } catch (err) {
      memLog.warn("decay_sweep", "failed", {
        errorCode: err instanceof Error ? "decay_sweep_error" : "decay_sweep_unknown",
      });
    }

    try {
      // Enqueue a consolidate job only when pending candidates exist and no
      // consolidate job is already active (pending/running/failed).
      const pending = await listCandidatesByStatus("pending", 1);
      if (pending.length === 0) return;
      const active = [
        ...(await listJobsByStatus("pending", 1)),
        ...(await listJobsByStatus("running", 1)),
        ...(await listJobsByStatus("failed", 1)),
      ].filter((j) => j.jobKind === "consolidate");
      if (active.length > 0) return;
      await enqueueConsolidateJob();
      memLog("manager", "sweep_enqueued");
    } catch (err) {
      memLog.warn("manager", "sweep_failed", {
        errorCode: err instanceof Error ? "sweep_error" : "sweep_unknown",
      });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = tick().finally(() => {
      inFlight = null;
      if (!stopped) timer = setTimeout(schedule, interval);
    });
  };

  schedule();
  sweepTimer = setInterval(() => {
    void sweep();
  }, sweepInterval);

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (sweepTimer) clearInterval(sweepTimer);
      if (inFlight) await inFlight;
    },
  };
}

// ── Per-job processing ───────────────────────────────────────────────

async function processConsolidateJob(
  job: MemoryJob,
  workerId: string,
  deps: ConsolidateDeps,
): Promise<void> {
  let claimLost = false;
  const heartbeatTimer = setInterval(async () => {
    try {
      const ok = await heartbeat(job.id, workerId);
      if (!ok && !claimLost) {
        claimLost = true;
        memLog.warn("manager", "claim_lost", { jobId: job.id });
      }
    } catch {
      // Transient — do NOT flip claim-lost (transient ≠ owner loss).
    }
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  let anyTransientFailure = false;
  let anyUnclosed = false;

  try {
    await reserveCandidatesForJob(job.id, workerId, CONSOLIDATE_BATCH_LIMIT);
    const items = await listItemsByJob(job.id, "reserved");

    for (const item of items) {
      if (claimLost) return;
      const outcome = await processItem(job, workerId, item, deps);
      if (outcome === "transient_failure") anyTransientFailure = true;
      else if (outcome === "unclosed") anyUnclosed = true;
      else if (outcome === "claim_lost") return;
    }

    if (anyTransientFailure || anyUnclosed) {
      const backoff = MEMORY_RETRY_BACKOFF_BASE_MS * Math.max(1, job.attemptCount);
      await markFailed(job.id, workerId, "items_failed_retry", backoff);
    } else {
      const ok = await markCompleted(job.id, workerId);
      if (ok) memLog("manager", "completed", { jobId: job.id });
      else memLog.warn("manager", "completion_claim_lost", { jobId: job.id });
    }
  } catch (err) {
    const backoff = MEMORY_RETRY_BACKOFF_BASE_MS * Math.max(1, job.attemptCount);
    await markFailed(
      job.id,
      workerId,
      err instanceof Error ? "job_error" : "job_unknown",
      backoff,
    );
    memLog.warn("manager", "job_failed", { jobId: job.id, errorCode: "job_error" });
  } finally {
    clearInterval(heartbeatTimer);
  }
}

type ItemOutcome = "done" | "transient_failure" | "unclosed" | "claim_lost" | "skipped";

/**
 * Process ONE reserved item: idempotent-close OR consolidate→apply→close. Returns
 * the outcome the job finalizer aggregates. Never throws — every error is mapped
 * to `transient_failure` (markItemFailed) so one bad item cannot fail the job.
 */
async function processItem(
  job: MemoryJob,
  workerId: string,
  item: MemoryJobItem,
  deps: ConsolidateDeps,
): Promise<ItemOutcome> {
  const transitioned = await markItemProcessing(item.id, job.id, workerId);
  if (!transitioned) {
    // Race / claim-lost — skip this item (another worker / state change).
    return "skipped";
  }

  const candidate = await getCandidateById(item.candidateId);
  if (!candidate) {
    await markItemFailed(item.id, job.id, workerId, "candidate_missing");
    return "transient_failure";
  }

  // Idempotent-close (R2#2): a non-pending candidate already has a committed
  // decision from a prior attempt whose markItemDone failed. Close the item with
  // that decision — NEVER re-apply (no double promote).
  if (candidate.status !== "pending") {
    const dec = await getLatestDecision(candidate.id);
    if (!dec) {
      await markItemFailed(item.id, job.id, workerId, "decided_without_decision");
      return "transient_failure";
    }
    const closed = await markItemDone(item.id, job.id, workerId, dec.id);
    return closed ? "done" : "unclosed";
  }

  const embedding = await getCandidateEmbedding(candidate.id);
  if (!embedding) {
    await markItemFailed(item.id, job.id, workerId, "embedding_missing");
    return "transient_failure";
  }

  try {
    const decision = await consolidateCandidate(candidate, embedding, deps);
    const applied = await applyDecisionAtomically({
      candidate,
      plan: decision.plan,
      jobId: job.id,
      workerId,
      // S5: ledger-grounded outcome + as-of boundary persisted in the SAME tx as
      // the decision (null for non-trade kinds / no surviving anchor).
      outcome: decision.outcome,
      availableAtDecisionTime: decision.availableAtDecisionTime,
      // S6a: reinforce the active entry a duplicate candidate confirms (2nd
      // confirmation), in the SAME tx as the decision.
      reinforce: decision.reinforce,
      // S8: pre-built graph plan (promote/supersede only; null → no graph —
      // fail-open). Applied under SAVEPOINT inside the same tx.
      graphPlan: decision.graphPlan,
    });

    if (decision.llmCalls > 0) {
      await bumpJobInference(job.id, {
        llmCalls: decision.llmCalls,
        ...(decision.costUsd !== null ? { costUsd: decision.costUsd } : {}),
      });
    }

    memLog("manager", "candidate_decided", {
      jobId: job.id,
      candidateId: candidate.id,
      decisionType: applied.decisionType,
      decisionId: applied.decisionId,
    });

    const closed = await markItemDone(item.id, job.id, workerId, applied.decisionId);
    // Owner-loss between commit and close: the decision IS durable but the item
    // is not closed → unclosed (retry's idempotent-close path will close it).
    return closed ? "done" : "unclosed";
  } catch (err) {
    // Transient: LLM timeout / malformed JSON / DB hiccup / owner-loss throw.
    const errorCode = err instanceof Error ? mapErrorCode(err) : "item_unknown";
    await markItemFailed(item.id, job.id, workerId, errorCode);
    return "transient_failure";
  }
}

function mapErrorCode(err: Error): string {
  const msg = err.message;
  if (msg.includes("claim lost")) return "claim_lost";
  if (msg.includes("timeout")) return "judge_timeout";
  if (msg.includes("malformed")) return "judge_malformed";
  if (msg.includes("schema_invalid")) return "judge_schema_invalid";
  if (msg.includes("config")) return "provider_config";
  return "item_error";
}
