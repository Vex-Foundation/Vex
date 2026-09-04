/**
 * Compaction IPC handlers — Track-2 worker status (read) + retry (mutation).
 *
 * Reads are backed by `compaction-db.ts`: a session with no compact jobs
 * resolves to `{ latest: null, activeCount: 0 }`; an unknown/foreign-scope
 * session resolves to `null` — never an error shape. The Track-2 executor is
 * owned by Electron main (`agent/compact-worker.ts`); the renderer never
 * schedules it. `retry` (stage 8-5) is the one mutation: main authorizes
 * app-scope, then the engine repo re-enqueues a permanently-failed job. The
 * internal job id never crosses to the renderer (targeted by session +
 * generation).
 */

import { CH } from "@shared/ipc/channels.js";
import {
  err,
  ok,
  type Result,
  type VexError,
  type VexErrorCode,
} from "@shared/ipc/result.js";
import {
  compactionHistoryInputSchema,
  compactionHistoryResultSchema,
  compactionRetryInputSchema,
  compactionRetryResultSchema,
  compactionStatusInputSchema,
  compactionStatusResultSchema,
  type CompactionHistoryResult,
  type CompactionRetryResult,
  type CompactionStatusResult,
} from "@shared/schemas/compaction.js";
import {
  getCompactionStatus,
  getRetryableCompactJob,
  listCompactionHistory,
} from "../database/compaction-db.js";
import { registerPreparationHandlers } from "./compaction/preparation.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { log } from "../logger/index.js";
import { registerHandler } from "./register-handler.js";

function registerGetStatusHandler(): () => void {
  return registerHandler({
    channel: CH.compaction.getStatus,
    domain: "compaction",
    inputSchema: compactionStatusInputSchema,
    outputSchema: compactionStatusResultSchema,
    handle: async (input, ctx): Promise<Result<CompactionStatusResult>> => {
      const outcome = await getCompactionStatus(input.sessionId);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:compaction:getStatus] ok sessionId=${input.sessionId} ` +
            `present=${outcome.data !== null} ` +
            `active=${outcome.data?.activeCount ?? 0} ` +
            `latest=${outcome.data?.latest?.status ?? "none"} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:compaction:getStatus] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

function registerListHistoryHandler(): () => void {
  return registerHandler({
    channel: CH.compaction.listHistory,
    domain: "compaction",
    inputSchema: compactionHistoryInputSchema,
    outputSchema: compactionHistoryResultSchema,
    handle: async (input, ctx): Promise<Result<CompactionHistoryResult>> => {
      const outcome = await listCompactionHistory(input.sessionId, input.limit);
      if (outcome.ok) {
        log.info(
          `[ipc:vex:compaction:listHistory] ok sessionId=${input.sessionId} ` +
            `present=${outcome.data !== null} count=${outcome.data?.length ?? 0} ` +
            `correlationId=${ctx.requestId}`,
        );
        return outcome;
      }
      log.info(
        `[ipc:vex:compaction:listHistory] errCode=${outcome.error.code} ` +
          `correlationId=${ctx.requestId}`,
      );
      return outcome;
    },
  });
}

function compactionError(
  code: VexErrorCode,
  message: string,
  correlationId: string,
  opts: { readonly retryable: boolean; readonly userActionable: boolean },
): Result<never, VexError> {
  return err({
    code,
    domain: "compaction",
    message,
    retryable: opts.retryable,
    userActionable: opts.userActionable,
    redacted: true,
    correlationId,
  });
}

/**
 * Re-enqueue a permanently-failed compaction generation (stage 8-5). App-scope
 * is authorized in main (`getRetryableCompactJob`); the engine repo owns the
 * state transition (`resetPermanentlyFailed`). A db-url failure is normalized
 * to a compaction-domain `internal.unexpected` rather than leaking the
 * runtime-helper error. The internal job id is never returned to the renderer.
 */
function registerRetryHandler(): () => void {
  return registerHandler({
    channel: CH.compaction.retry,
    domain: "compaction",
    inputSchema: compactionRetryInputSchema,
    outputSchema: compactionRetryResultSchema,
    handle: async (input, ctx): Promise<Result<CompactionRetryResult>> => {
      const resolved = await getRetryableCompactJob(
        input.sessionId,
        input.checkpointGeneration,
      );
      if (!resolved.ok) return resolved; // internal.unexpected (compaction), redacted
      if (resolved.data === null) {
        return compactionError(
          "compaction.not_found",
          "That compaction no longer exists for this session.",
          ctx.requestId,
          { retryable: false, userActionable: true },
        );
      }
      if (resolved.data.status !== "permanently_failed") {
        return compactionError(
          "compaction.invalid_state",
          "Only a permanently-failed compaction can be retried.",
          ctx.requestId,
          { retryable: false, userActionable: true },
        );
      }
      const jobId = resolved.data.id;

      const dbUrl = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrl.ok) {
        return compactionError(
          "internal.unexpected",
          "Unable to retry compaction. Verify services are running and retry.",
          ctx.requestId,
          { retryable: true, userActionable: true },
        );
      }

      try {
        const { resetPermanentlyFailed } = await import(
          "@vex-agent/db/repos/compact-jobs/index.js"
        );
        const outcome = await resetPermanentlyFailed(jobId);
        if (outcome.ok) {
          log.info(
            `[ipc:vex:compaction:retry] ok generation=${input.checkpointGeneration} ` +
              `status=pending correlationId=${ctx.requestId}`,
          );
          return ok({
            checkpointGeneration: input.checkpointGeneration,
            status: "pending",
          });
        }
        // Lost a race with the worker between the scope read and the reset.
        if (outcome.reason === "not_found") {
          return compactionError(
            "compaction.not_found",
            "That compaction no longer exists for this session.",
            ctx.requestId,
            { retryable: false, userActionable: true },
          );
        }
        return compactionError(
          "compaction.invalid_state",
          "Only a permanently-failed compaction can be retried.",
          ctx.requestId,
          { retryable: false, userActionable: true },
        );
      } catch (cause) {
        log.warn(
          `[ipc:vex:compaction:retry] failed generation=${input.checkpointGeneration} ` +
            `correlationId=${ctx.requestId}`,
          cause,
        );
        return compactionError(
          "internal.unexpected",
          "Unable to retry compaction. Verify services are running and retry.",
          ctx.requestId,
          { retryable: true, userActionable: true },
        );
      }
    },
  });
}

export function registerCompactionHandlers(): ReadonlyArray<() => void> {
  return [
    registerGetStatusHandler(),
    registerListHistoryHandler(),
    registerRetryHandler(),
    // Compaction v2 — the `compaction_preparations` track (bounded read + the
    // one-CAS apply request). Its own module: different table, different
    // lifecycle, different reason to change.
    ...registerPreparationHandlers(),
  ];
}
