/**
 * Thrown-failure pause path: persist a recoverable provider / runtime
 * failure as `paused_error`.
 *
 * Covers anything thrown from the post-`createRun` block in `startMission`
 * or the post-`updateStatus("running")` block in `resumeMissionRun`.
 *
 * The mission row is intentionally left at `running` so `getActiveRunBySession`
 * still surfaces the run for `/retry` and the ingress-router paused_error
 * branch. The caller MUST re-throw `MissionRunPausedError` (defined in
 * engine/types.ts) so shell action wrappers turn the failure into a real
 * `{ ok: false, error, hint }` instead of a fake success.
 */

import logger from "@utils/logger.js";
import {
  enqueueAutoRetryWake,
  persistErrorPauseWithMaybeAutoRetry,
} from "../mission-auto-retry.js";
import { readMissionErrorSignal } from "../mission-error-signal.js";
import { emitFinalizeControlState } from "./control-state-emit.js";
import { emitMissionPausedErrorReport } from "./bug-report-emit.js";

/**
 * Character bound on the persisted error text. The bound exists because the
 * message is free text from a provider or an SDK and lands in a durable row,
 * a bug-report description and a log line.
 */
const ERROR_MESSAGE_LIMIT = 4096;

export async function finalizeMissionRunError(
  missionId: string,
  runId: string,
  sessionId: string,
  err: unknown,
): Promise<void> {
  const errorMessage = formatErrorMessage(err);
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  // Bounded transport signals (own-properties, never message text) - fed into
  // the persisted evidence below AND the bug-report `context`.
  //
  // `errorClass` above is `err.constructor.name`, which is very nearly always
  // the useless literal "Error"; the signal's own `errorClass` comes from the
  // CLOSED SDK dictionary and its `errorType` is OpenRouter's canonical enum.
  // Persisting THOSE is what lets the runtime DTO expose a `lastError` the
  // renderer can classify - one vocabulary, the same one the engine error
  // push channel uses. The free-text `errorMessage` stays server-side.
  const signal = readMissionErrorSignal(err);
  const causeCode = signal.causeCode;
  // Log first - even if the DB write below fails, the failure stays visible.
  logger.error("engine.mission.runtime_throw", {
    runId,
    missionId,
    sessionId,
    errorClass,
    errorMessage,
  });

  try {
    // Phase 4d: decide auto-retry eligibility on a FRESH locked read and persist
    // paused_error (incrementing the retry count in the same tx when eligible).
    const decision = await persistErrorPauseWithMaybeAutoRetry(
      {
        runId,
        sessionId,
        err,
        summary: errorMessage,
        evidenceBase: {
          errorMessage,
          errorClass,
          causeCode,
          // Bounded classification vocabulary - read by the runtime DTO's
          // `lastError`. Keys are omitted when null so evidence written by
          // older code and evidence with nothing to say look identical to the
          // reader (absent ⇒ no lastError).
          ...(signal.errorType !== null ? { errorType: signal.errorType } : {}),
          ...(signal.errorClass !== null ? { sdkErrorClass: signal.errorClass } : {}),
          ...(signal.status !== null ? { statusCode: signal.status } : {}),
          occurredAt: new Date().toISOString(),
          missionId,
          runId,
        },
      },
      Date.now(),
    );
    await emitFinalizeControlState(sessionId, runId);
    if (!decision.persisted) {
      // The run was already TERMINAL under the row lock - almost always an
      // operator Stop that landed while the loop was unwinding. Nothing was
      // written and nothing may be: a terminal run row is immutable audit
      // history. The failure itself stays visible through the `error` log
      // above; the bug report below is deliberately skipped because its
      // `runtimeStatus: "paused_error"` would be a false statement about a
      // run that is actually stopped.
      logger.warn("engine.mission.runtime_throw_after_terminal", {
        runId,
        missionId,
        sessionId,
        errorClass,
      });
      return;
    }
    // Enqueue the retry wake AFTER the persist commits. A failed/duplicate
    // enqueue leaves the run recoverable (no auto-resume) - never throws.
    if (decision.scheduled !== null) {
      await enqueueAutoRetryWake({
        sessionId,
        runId,
        attempt: decision.scheduled.attempt,
        dueAt: decision.scheduled.dueAt,
      });
      logger.info("engine.mission.auto_retry_scheduled", {
        runId,
        missionId,
        sessionId,
        attempt: decision.scheduled.attempt,
        nextRetryAt: decision.scheduled.dueAt,
      });
    }
    await emitMissionPausedErrorReport(
      { sessionId, missionId, runId },
      { errorClass, errorMessage, causeCode },
    );
  } catch (dbErr: unknown) {
    logger.error("engine.mission.paused_error_persist_failed", {
      runId,
      missionId,
      sessionId,
      dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
    // Re-throw so the caller's catch path still trips the recoverable
    // throw - masking the persist failure would silently leave the run
    // in `running` while the user sees the error, recreating the very
    // orphan-state bug this module exists to fix.
    throw dbErr;
  }
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, ERROR_MESSAGE_LIMIT);
  return String(err).slice(0, ERROR_MESSAGE_LIMIT);
}
