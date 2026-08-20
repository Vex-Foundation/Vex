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
import { emitMemoryWorkerPermanentlyFailedBug } from "./bug-emit.js";
import { emitEngineError, errorDetailOf } from "../runtime/error-bus.js";
import {
  readMissionErrorSignal,
  type MissionErrorSignal,
} from "../core/runner/mission-error-signal.js";
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

/**
 * Bounded, SESSION-LESS engine-error emit for a memory job that permanently
 * gave up.
 *
 * `sessionId: null` is a positive statement, not a missing value: `memory_jobs`
 * has no `session_id` column because consolidation and reconcile are global
 * maintenance over `knowledge_entries`, not work done for one conversation. The
 * global error surface is the only consumer that reads these; every
 * session-scoped consumer ignores them by contract.
 *
 * Codes plus the raw message as `detail`, sanitized at the main-side bridge.
 * `readMissionErrorSignal` reads own-properties and never walks `.cause`.
 * `null` is a legitimate input (nothing throwable was captured) and yields an
 * all-null signal rather than a guess — but the items-failed path now hands
 * over the FIRST item error it caught, because an all-null signal is exactly
 * what left the UI saying the cause was not reported.
 */
function emitMemoryJobFailure(job: MemoryJob, err: unknown): void {
  const signal = readMissionErrorSignal(err);
  emitEngineError({
    sessionId: null,
    scope: "memory",
    errorType: signal.errorType,
    errorClass: signal.errorClass,
    statusCode: signal.status,
    causeCode: signal.causeCode,
    retryAfterSeconds: signal.retryAfterSeconds,
    detail: errorDetailOf(err),
  });
  memLog.warn("manager", "permanently_failed", {
    jobId: job.id,
    jobKind: job.jobKind,
  });
}

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
  // The FIRST item error, carried out of the loop so a permanent give-up can
  // report a cause. First rather than last: a batch usually fails for one
  // reason, and the earliest one is the one that was not itself a consequence.
  let firstItemError: Error | null = null;

  try {
    await reserveCandidatesForJob(job.id, workerId, CONSOLIDATE_BATCH_LIMIT);
    const items = await listItemsByJob(job.id, "reserved");

    for (const item of items) {
      if (claimLost) return;
      const result = await processItem(job, workerId, item, deps);
      if (result.error && firstItemError === null) firstItemError = result.error;
      if (result.outcome === "transient_failure") anyTransientFailure = true;
      else if (result.outcome === "unclosed") anyUnclosed = true;
      else if (result.outcome === "claim_lost") return;
    }

    if (anyTransientFailure || anyUnclosed) {
      const backoff = MEMORY_RETRY_BACKOFF_BASE_MS * Math.max(1, job.attemptCount);
      const result = await markFailed(job.id, workerId, "items_failed_retry", backoff);
      // `ok` is not redundant with `terminal`: markFailed decides `terminal`
      // from a SELECT and re-checks ownership in the UPDATE's WHERE clause, so
      // a row reclaimed in between returns `{ ok: false, terminal: true }` —
      // nothing written, job alive under its new owner. Reporting on
      // `terminal` alone files a bug report for a failure that did not happen.
      if (result.ok && result.terminal) {
        emitMemoryJobFailure(job, firstItemError);
        await emitMemoryWorkerPermanentlyFailedBug({
          jobId: job.id,
          jobKind: job.jobKind,
          // The item error's message is already scrubbed by
          // `normalizeOpenRouterError`; this channel is server-side diagnostics,
          // and "items_failed_retry" alone told nobody anything.
          errorMsg:
            firstItemError === null
              ? "items_failed_retry"
              : `items_failed_retry: ${firstItemError.message}`,
        });
      }
    } else {
      const ok = await markCompleted(job.id, workerId);
      if (ok) memLog("manager", "completed", { jobId: job.id });
      else memLog.warn("manager", "completion_claim_lost", { jobId: job.id });
    }
  } catch (err) {
    const backoff = MEMORY_RETRY_BACKOFF_BASE_MS * Math.max(1, job.attemptCount);
    const result = await markFailed(
      job.id,
      workerId,
      err instanceof Error ? "job_error" : "job_unknown",
      backoff,
    );
    memLog.warn("manager", "job_failed", { jobId: job.id, errorCode: "job_error" });
    // Terminal give-up settled BY THIS WORKER — see the ownership note above.
    // The raw message reaches the internal diagnostics channel only; the job
    // row itself still stores just the coded `job_error`.
    if (result.ok && result.terminal) {
      emitMemoryJobFailure(job, err);
      await emitMemoryWorkerPermanentlyFailedBug({
        jobId: job.id,
        jobKind: job.jobKind,
        errorMsg: err instanceof Error ? err.message : String(err),
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

type ItemOutcome = "done" | "transient_failure" | "unclosed" | "claim_lost" | "skipped";

/**
 * The outcome plus, on a caught throw, the error itself. The error travels so
 * the job finalizer can report WHY a permanent give-up happened; it is the
 * already-normalized (scrubbed, own-properties-only) error, never a raw SDK
 * object.
 */
interface ItemResult {
  readonly outcome: ItemOutcome;
  readonly error?: Error;
}

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
): Promise<ItemResult> {
  const transitioned = await markItemProcessing(item.id, job.id, workerId);
  if (!transitioned) {
    // Race / claim-lost — skip this item (another worker / state change).
    return { outcome: "skipped" };
  }

  const candidate = await getCandidateById(item.candidateId);
  if (!candidate) {
    await markItemFailed(item.id, job.id, workerId, "candidate_missing");
    return { outcome: "transient_failure" };
  }

  // Idempotent-close (R2#2): a non-pending candidate already has a committed
  // decision from a prior attempt whose markItemDone failed. Close the item with
  // that decision — NEVER re-apply (no double promote).
  if (candidate.status !== "pending") {
    const dec = await getLatestDecision(candidate.id);
    if (!dec) {
      await markItemFailed(item.id, job.id, workerId, "decided_without_decision");
      return { outcome: "transient_failure" };
    }
    const closed = await markItemDone(item.id, job.id, workerId, dec.id);
    return { outcome: closed ? "done" : "unclosed" };
  }

  const embedding = await getCandidateEmbedding(candidate.id);
  if (!embedding) {
    await markItemFailed(item.id, job.id, workerId, "embedding_missing");
    return { outcome: "transient_failure" };
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
    return { outcome: closed ? "done" : "unclosed" };
  } catch (err) {
    // Transient: LLM timeout / malformed JSON / DB hiccup / owner-loss throw.
    // ONE read of the error's own-properties feeds both the stored code and the
    // log line, so the two can never disagree about what happened.
    const signal = readMissionErrorSignal(err);
    const errorCode = err instanceof Error ? mapErrorCode(err, signal) : "item_unknown";
    await markItemFailed(item.id, job.id, workerId, errorCode);
    // Say WHY, at the only place that still knows. Bounded fields only: the
    // scrubbed message never enters a memory log line by allowlist design, so
    // the diagnosis rides on the own-properties `normalizeOpenRouterError`
    // attaches. Silence here is what left the UI with nothing to report.
    memLog.warn("manager", "item_failed", {
      jobId: job.id,
      candidateId: item.candidateId,
      errorCode,
      ...(signal.status !== null ? { statusCode: signal.status } : {}),
      ...(signal.errorClass !== null ? { errorKind: signal.errorClass } : {}),
      ...(signal.causeCode !== null ? { causeCode: signal.causeCode } : {}),
    });
    return {
      outcome: "transient_failure",
      ...(err instanceof Error ? { error: err } : {}),
    };
  }
}

/** The two status-less SDK classes that mean "answered, but unreadable". */
const VALIDATION_ERROR_CLASSES: ReadonlySet<string> = new Set([
  "ResponseValidationError",
  "SDKValidationError",
]);

/**
 * Map a caught item failure to the bounded code stored on the item row.
 *
 * TYPED SIGNALS FIRST. A real provider rejection carries `statusCode` /
 * `errorClass` own-properties and a scrubbed message that matches none of the
 * substrings below — so message matching alone bucketed every OpenRouter
 * refusal as the opaque `item_error`, which is precisely what the user saw. The
 * substring map stays as the fallback for this module's OWN named throws
 * (`memory_judge_timeout`, …), which carry no status.
 */
function mapErrorCode(err: Error, signal: MissionErrorSignal): string {
  if (signal.status !== null) return providerCodeForStatus(signal.status);
  // Status-less but class-identified: either "the provider answered and we
  // could not read it" or "we never reached the provider". Keeping those apart
  // is the whole reason the class name is captured before normalization.
  if (signal.errorClass !== null) {
    return VALIDATION_ERROR_CLASSES.has(signal.errorClass)
      ? "provider_unreadable_response"
      : "provider_unreachable";
  }

  const msg = err.message;
  if (msg.includes("claim lost")) return "claim_lost";
  if (msg.includes("timeout")) return "judge_timeout";
  if (msg.includes("malformed")) return "judge_malformed";
  if (msg.includes("schema_invalid")) return "judge_schema_invalid";
  if (msg.includes("config")) return "provider_config";
  return "item_error";
}

/** Bounded enum tokens (memLog `enum` category: letters/underscores only). */
function providerCodeForStatus(status: number): string {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 402) return "provider_payment_required";
  if (status === 404) return "provider_not_found";
  if (status === 408) return "provider_timeout";
  if (status === 429) return "provider_rate_limited";
  if (status >= 500) return "provider_server_error";
  if (status >= 400) return "provider_bad_request";
  return "item_error";
}
