/**
 * Compact-jobs executor — archive chunking worker.
 *
 * Mirrors `engine/wake/executor.ts` structure: poll loop with idempotent
 * shutdown, in-memory per-session mutex preventing concurrent processing
 * of the same session's jobs, bootstrap stale-recovery on start.
 *
 * Lifecycle per job:
 *   1. claimNextDueJob(workerId) under FOR UPDATE SKIP LOCKED
 *   2. Start heartbeat interval
 *   3. Load archived prefix from messages_archive via source_*_message_id
 *   4. Build chunker prompt + call OpenRouter (same provider as agent —
 *      reads OPENROUTER_API_KEY + AGENT_MODEL from env populated by
 *      local-secret-vault at boot, same path the in-turn provider uses)
 *   5. Parse JSON output, validate themes, redact, exclusion-check
 *   6. For each accepted chunk: prepareMemoryRender → embedDocument →
 *      insertPreparedMemory (exact-body embedding per codex contract)
 *   7. Stop heartbeat
 *   8. markCompleted with audit (workerId-owner-checked)
 *
 * On failure: markFailed schedules retry with exponential backoff (workerId
 * owner-checked); after WORKER_MAX_ATTEMPTS the job goes permanently_failed.
 */

import { randomUUID } from "node:crypto";

import {
  claimNextDueJob,
  heartbeat,
  markCompleted,
  markFailed,
  recoverStaleRunning,
  type CompactJob,
} from "@vex-agent/db/repos/compact-jobs/index.js";
// Pure helpers extracted for scalability:
//   `archived-prefix.ts`  — loadArchivedPrefix + renderRedactedArchivedTranscript + redactStringArray.
//   `chunker-call.ts`     — callChunkerLLM + ChunkerOutputSchema + types.
//   `bug-emit.ts`         — Phase 2 BUG-REPORTING terminal-failure emit.
//   `chunk-processing.ts` — per-chunk redact + validate + render + embed + insert,
//                           with claim-loss discriminated-union outcome.
import { loadArchivedPrefix } from "./archived-prefix.js";
import { callChunkerLLM } from "./chunker-call.js";
import { emitCompactWorkerPermanentlyFailedBug } from "./bug-emit.js";
import { emitEngineError, errorDetailOf } from "../runtime/error-bus.js";
import { readMissionErrorSignal } from "../core/runner/mission-error-signal.js";
import { processChunkerOutput } from "./chunk-processing.js";
import { shouldEmitHeartbeatFailure } from "./heartbeat-rate-limit.js";
import {
  CHUNKER_RETRY_BACKOFF_BASE_MS,
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_STALE_THRESHOLD_MS,
} from "@vex-agent/engine/compact-jobs/policy.js";
import logger from "@utils/logger.js";

export interface CompactJobsExecutorHandle {
  stop: () => Promise<void>;
}

export interface StartOptions {
  /** Poll interval in ms. Default 5000. */
  pollIntervalMs?: number;
}

const POLL_INTERVAL_MS_DEFAULT = 5_000;

export function startCompactJobsExecutor(
  options: StartOptions = {},
): CompactJobsExecutorHandle {
  const interval = options.pollIntervalMs ?? POLL_INTERVAL_MS_DEFAULT;
  const workerId = `compact-worker-${process.pid}-${randomUUID().slice(0, 8)}`;
  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;
  const sessionMutex = new Set<string>(); // per-session in-flight set
  // Rate-limit `compact-worker.skip_no_provider_config` to one log per
  // missing-config streak. Without this the warning fires every poll interval
  // for the entire window the operator hasn't supplied OPENROUTER_API_KEY /
  // AGENT_MODEL — flooding logs and obscuring real issues. Reset to false the
  // moment config becomes present so a regression after recovery surfaces.
  let warnedNoProviderConfig = false;

  // Bootstrap stale recovery — handles app-crash leftovers. DB failures
  // here are non-fatal for the executor lifecycle (next tick will retry
  // claim), but the rejection must NOT bubble into Node's
  // unhandledRejection trap.
  void recoverStaleRunning(WORKER_STALE_THRESHOLD_MS)
    .then((n) => {
      if (n > 0) {
        logger.info("compact-worker.stale_recovered", { count: n, workerId });
      }
    })
    .catch((err) => {
      logger.warn("compact-worker.stale_recovery_failed", {
        workerId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

  const tick = async (): Promise<void> => {
    try {
      // Pre-claim provider-config gate — claimNextDueJob increments
      // attempt_count, so claiming and then throwing on missing config would
      // burn the retry budget and prematurely escalate jobs to
      // permanently_failed. Stay idle until env is wired (operator unlocks
      // OPENROUTER_API_KEY / sets AGENT_MODEL → next tick claims normally).
      if (!process.env.OPENROUTER_API_KEY || !process.env.AGENT_MODEL) {
        if (!warnedNoProviderConfig) {
          logger.warn("compact-worker.skip_no_provider_config", { workerId });
          warnedNoProviderConfig = true;
        }
        return;
      }
      warnedNoProviderConfig = false;
      const job = await claimNextDueJob(workerId);
      if (!job) return;
      if (sessionMutex.has(job.sessionId)) {
        // Another in-process pick already touched this session — release the
        // claim by failing it back to pending. Should be rare.
        await markFailed(job.id, workerId, "in_process_session_busy", 5_000);
        return;
      }
      sessionMutex.add(job.sessionId);
      try {
        await processJob(job, workerId);
      } finally {
        sessionMutex.delete(job.sessionId);
      }
    } catch (err) {
      logger.error("compact-worker.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
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

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (inFlight) await inFlight;
    },
  };
}

// ── Per-job processing ───────────────────────────────────────────

async function processJob(job: CompactJob, workerId: string): Promise<void> {
  const startMs = Date.now();
  // Cancellation flag — flipped to `true` when the heartbeat reports the
  // worker has lost ownership of this row (another worker recovered the
  // stale claim). Checked between expensive stages so we cap wasted work
  // and avoid the doubly-claimed compact path producing duplicate chunker
  // output. The owner-checked `markCompleted` / `markFailed` at terminal
  // states already prevents state corruption — this is the upstream
  // cost-control guard codex P2 round 3 requested.
  let claimLost = false;
  const heartbeatTimer = setInterval(async () => {
    try {
      const ok = await heartbeat(job.id, workerId);
      if (!ok && !claimLost) {
        claimLost = true;
        logger.warn("compact-worker.claim_lost", {
          jobId: job.id,
          sessionId: job.sessionId,
          workerId,
        });
      }
    } catch (err) {
      // Network/DB hiccup — don't flip the claim-lost flag (transient ≠ owner
      // loss). Rate-limited per workerId so a long outage window emits one
      // log per minute instead of one per tick.
      if (shouldEmitHeartbeatFailure(workerId)) {
        logger.warn("compact-worker.heartbeat_failed", {
          jobId: job.id,
          sessionId: job.sessionId,
          workerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }, WORKER_HEARTBEAT_INTERVAL_MS);

  try {
    const archivedPrefix = await loadArchivedPrefix(
      job.sessionId,
      job.sourceStartMessageId,
      job.sourceEndMessageId,
    );
    if (claimLost) return;
    if (archivedPrefix.length === 0) {
      // An empty range against committed source_*_message_id values means
      // the archive write was rolled back, the messages were re-archived
      // elsewhere, or a row range disappeared — none of which are a "0
      // chunks" success. Marking completed would silently drop the job's
      // implied work; treat as retryable so the next attempt re-reads the
      // archive after any in-flight Phase II finishes, or surfaces a
      // permanent corruption signal once attempts are exhausted.
      logger.warn("compact-worker.empty_archive_range", {
        jobId: job.id,
        sessionId: job.sessionId,
        sourceStartMessageId: job.sourceStartMessageId,
        sourceEndMessageId: job.sourceEndMessageId,
      });
      throw new Error("compact_worker_empty_archive_range");
    }

    const chunkerCall = await callChunkerLLM(job, archivedPrefix);
    const chunkerOutput = chunkerCall.chunks;
    if (claimLost) return;

    // Per-chunk redact → validate → exclusion-scan → render → embed → insert.
    // Helper owns the loop; caller pattern-matches the discriminated outcome.
    const chunkOutcome = await processChunkerOutput({
      job,
      chunkerOutput,
      claimGuard: { isLost: () => claimLost },
    });
    if (chunkOutcome.kind === "claim_lost_silent") return;
    if (chunkOutcome.kind === "claim_lost_after_loop") {
      logger.warn("compact-worker.exit_after_claim_lost", {
        jobId: job.id,
        sessionId: chunkOutcome.sessionId,
        workerId,
        chunksInserted: chunkOutcome.insertedSoFar,
      });
      return;
    }
    const { inserted, rejectedExclusion } = chunkOutcome;

    // Model as the loaded config actually RESOLVED it, falling back to the env
    // var only when the config was unreadable. The two can disagree — the
    // provider reads env at construction while a config load can be served
    // from cache — and the audit row should record what the call used.
    const inferenceModel = chunkerCall.model ?? process.env.AGENT_MODEL ?? "unknown";
    const completedOk = await markCompleted(job.id, workerId, {
      chunksInserted: inserted,
      chunksRejectedByExclusion: rejectedExclusion,
      // PR2 never drops a chunk on redaction count alone — hard-redact
      // placeholders sanitize in-place. The audit column stays available
      // (schema-preserved) and reports 0 here; a redaction-threshold drop
      // policy can populate it in a follow-up PR.
      chunksRejectedByRedaction: 0,
      inferenceProvider: "openrouter",
      inferenceModel,
      // Real provider-reported cost for the chunker call. The column already
      // existed and was hardcoded null. This stays on `compact_jobs` and is
      // deliberately NOT written to `usage_log`: that table feeds the user's
      // per-session totals in the right sidebar and must keep meaning "this
      // conversation", not "this conversation plus background maintenance".
      // `null` when the provider did not report a cost.
      costUsd: chunkerCall.costUsd,
    });
    if (completedOk) {
      logger.info("compact-worker.completed", {
        jobId: job.id,
        sessionId: job.sessionId,
        generation: job.checkpointGeneration,
        chunksInserted: inserted,
        chunksRejectedByExclusion: rejectedExclusion,
        chunksRejectedByRedaction: 0,
        transcriptRedactionHardCount: chunkerCall.transcriptRedactionCounts.hard,
        transcriptRedactionMaskCount: chunkerCall.transcriptRedactionCounts.mask,
        durationMs: Date.now() - startMs,
        inferenceModel,
      });
    } else {
      // Owner-check failed — another worker recovered the claim mid-run or
      // the row was already terminated. Log so operator can spot the race;
      // no retry, the chunks are already in the DB so the work is durable.
      logger.warn("compact-worker.completion_claim_lost", {
        jobId: job.id,
        sessionId: job.sessionId,
        workerId,
      });
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const backoff = CHUNKER_RETRY_BACKOFF_BASE_MS * Math.max(1, job.attemptCount);
    const result = await markFailed(job.id, workerId, errorMsg, backoff);
    logger.warn("compact-worker.job_failed", {
      jobId: job.id,
      sessionId: job.sessionId,
      error: errorMsg,
      terminal: result.terminal,
      ok: result.ok,
    });
    // Only a terminal failure THIS WORKER actually settled surfaces.
    //
    // `ok` is not redundant with `terminal`: `markFailed` decides `terminal`
    // from a SELECT, then re-checks ownership in the UPDATE's WHERE clause. If
    // another worker reclaimed the row in between (recoverStaleRunning after a
    // heartbeat lapse), the CAS matches zero rows and the repo returns
    // `{ ok: false, terminal: true }` — nothing was written, the job is still
    // alive under its new owner, and the retry may well succeed. Reporting on
    // `terminal` alone told the user their compaction had permanently failed
    // when it had not, and filed a bug report to match.
    //
    // Non-terminal failures stay silent either way: the job retries, and a
    // banner per attempt is noise, not signal.
    if (result.ok && result.terminal) {
      // A compact job that gives up permanently is a real failure the user
      // must be able to see: the session's context is not being compacted, so
      // the NEXT turn is the one that hits the context wall. Until the error
      // channel existed this produced a bug report and a log line and nothing
      // the window could render.
      //
      // Codes plus the raw message as `detail` - sanitized at the main-side
      // bridge before it can reach the renderer (owner decree 2026-08-02).
      // `readMissionErrorSignal` reads own-properties only, never `.cause`.
      const signal = readMissionErrorSignal(err);
      emitEngineError({
        sessionId: job.sessionId,
        scope: "compact",
        errorType: signal.errorType,
        errorClass: signal.errorClass,
        statusCode: signal.status,
        causeCode: signal.causeCode,
        retryAfterSeconds: signal.retryAfterSeconds,
        detail: errorDetailOf(err),
      });
      await emitCompactWorkerPermanentlyFailedBug({
        jobId: job.id,
        sessionId: job.sessionId,
        errorMsg,
      });
    }
  } finally {
    clearInterval(heartbeatTimer);
  }
}

// Archived prefix loading + chunker LLM call live in
// `archived-prefix.ts` and `chunker-call.ts`. Imported at the top
// of this file.
