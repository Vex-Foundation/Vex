/**
 * Mission run finalisation — turns a `runTurnLoop` outcome (or a thrown
 * error) into the right `mission_runs` / `missions` row state.
 *
 * Two entry points:
 *   - `finalizeMissionRunStatus(...)` — happy path: the loop returned with
 *     a `stopReason` (or null for a still-running tape), and we map that
 *     to the correct terminal / paused / running status pair across the
 *     run row and its parent mission row.
 *   - `finalizeMissionRunError(...)` — provider error / hydrate failure /
 *     anything thrown from the post-`createRun` block in `startMission` or
 *     the post-`updateStatus("running")` block in `resumeMissionRun`.
 *     Persists `paused_error` with structured evidence; the caller is
 *     expected to re-throw `MissionRunPausedError` so shell wrappers map
 *     the failure to `{ ok: false }` instead of a fake "started" line.
 */

import type { MissionStatus, StopReason } from "../../types.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";
import { consumeMissionRunAbortIntent } from "./abort.js";
import { reconcileDraftReadiness } from "../../mission/draft-readiness.js";
import {
  isContinuableRuntimeStop,
  scheduleRuntimeContinuation,
} from "./runtime-continuation.js";
import {
  enqueueAutoRetryWake,
  persistErrorPauseWithMaybeAutoRetry,
} from "./mission-auto-retry.js";
import { readMissionErrorSignal } from "./mission-error-signal.js";

const ERROR_MESSAGE_LIMIT = 4096;

/**
 * Helper — broadcast the post-finalize control-state event (puzzle 03).
 * Codex review acceptance: turn-loop emits at observe time with the
 * still-active lease; this helper fires AFTER finalize so the renderer
 * sees the canonical terminal status (e.g. `stopped` → `cancelled`)
 * and the lease cleared. Wraps a DB re-read for canonical state.
 */
async function emitFinalizeControlState(
  sessionId: string,
  runId: string,
): Promise<void> {
  try {
    const { controlStateBus, CONTROL_STATE_EVENT_TYPE } = await import(
      "../../runtime/control-bus.js"
    );
    const { getLease } = await import(
      "../../../db/repos/runner-leases.js"
    );
    const run = await missionRunsRepo.getRun(runId);
    const lease = await getLease(sessionId);
    if (run === null) return;
    controlStateBus.emit({
      type: CONTROL_STATE_EVENT_TYPE,
      sessionId,
      missionRunId: runId,
      runStatus: run.status,
      stopReason: run.stopReason ?? null,
      pendingControlKind: null,
      leaseActive: lease !== null && lease.expiresAt >= new Date(),
      leaseExpiresAt:
        lease !== null && lease.expiresAt >= new Date()
          ? lease.expiresAt.toISOString()
          : null,
      correlationId: null,
    });
  } catch {
    // intentionally swallowed — finalize must not break on bus errors
  }
}

export async function finalizeMissionRunStatus(
  missionId: string,
  runId: string,
  sessionId: string,
  stopReason: StopReason | null,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
): Promise<MissionStatus> {
  if (!stopReason) return "running";

  const { shouldTerminateRun } = await import("../stop-conditions.js");

  if (shouldTerminateRun(stopReason)) {
    if (stopReason === "user_stopped" && consumeMissionRunAbortIntent(runId) === "edit") {
      await missionRunsRepo.updateStatus(runId, "stopped", stopReason, stopPayload);
      await missionsRepo.clearApprovedAt(missionId);
      await missionsRepo.setStatus(missionId, "draft");
      // The async finalizer runs AFTER `stopMissionRunForEdit` already
      // reconciled once (abort.ts) — this demote-then-finalize sequence is
      // exactly the timing window issue #41 needs closed at every write
      // site, not just the first one.
      const reconciled = await reconcileDraftReadiness(missionId);
      await emitFinalizeControlState(sessionId, runId);
      return reconciled.promoted ? "ready" : "draft";
    }

    const status: MissionStatus = stopReason === "goal_reached"
      ? "completed"
      : stopReason === "user_stopped"
        ? "cancelled"
        : "failed";
    await missionsRepo.setStatus(missionId, status);
    await missionRunsRepo.updateStatus(runId, status, stopReason, stopPayload);
    await emitFinalizeControlState(sessionId, runId);
    return status;
  }

  if (isContinuableRuntimeStop(stopReason)) {
    const continuation = await scheduleRuntimeContinuation({
      sessionId,
      missionRunId: runId,
      trigger: stopReason,
    });
    await missionRunsRepo.updateStatus(runId, "paused_wake", "waiting_for_wake", {
      summary: `${stopReason}: runtime slice exhausted; automatic continuation scheduled`,
      evidence: {
        trigger: stopReason,
        dueAt: continuation.dueAt,
        enqueued: continuation.enqueued,
      },
    });
    return "running";
  }

  if (stopReason === "system_error") {
    await missionsRepo.setStatus(missionId, "failed");
    await missionRunsRepo.updateStatus(runId, "failed", stopReason);
    await emitFinalizeControlState(sessionId, runId);
    // Phase 2 BUG-REPORTING emit (puzzle 03): terminal `system_error`
    // is a hard failure surface — record the mission state. Fail-
    // closed so a sink outage cannot mask the terminal flip.
    const { getBugReportSink } = await import(
      "../../support/bug-report-registry.js"
    );
    const { emitBugReportSafe } = await import(
      "../../../../lib/diagnostics/bug-report-sink.js"
    );
    await emitBugReportSafe(
      getBugReportSink(),
      {
        source: "agent",
        category: "mission_system_error",
        severity: "critical",
        title: "mission.system_error",
        description: stopPayload?.summary ?? "system_error terminal",
        refs: {
          sessionId,
          missionId,
          missionRunId: runId,
        },
        agentContext: {
          stopReason: "system_error",
          runtimeStatus: "failed",
        },
      },
      logger,
    );
    return "failed";
  }

  // PR2 cutover: the runtime escalates to `compact_unable_at_critical` when
  // the forced-fallback compact returns `noop` twice in a row at critical
  // band — the agent cannot make forward progress without compaction it
  // refuses to perform. Treat as a paused error (operator intervention
  // surface) rather than a hard "failed" finalisation: the run row stays
  // visible for /retry just like provider-error pauses, and the parent
  // mission row stays `running` so the active-run lookup still surfaces it.
  if (stopReason === "compact_unable_at_critical") {
    await missionRunsRepo.updateStatus(runId, "paused_error", stopReason, {
      summary: stopPayload?.summary ?? "Two consecutive forced-fallback noops at critical pressure — operator review required.",
      evidence: stopPayload?.evidence,
    });
    return "running";
  }

  return "running";
}

/**
 * Persist a recoverable provider / runtime failure as `paused_error`.
 *
 * The mission row is intentionally left at `running` so `getActiveRunBySession`
 * still surfaces the run for `/retry` and the ingress-router paused_error
 * branch. The caller MUST re-throw `MissionRunPausedError` (defined in
 * engine/types.ts) so shell action wrappers turn the failure into a real
 * `{ ok: false, error, hint }` instead of a fake success.
 */
export async function finalizeMissionRunError(
  missionId: string,
  runId: string,
  sessionId: string,
  err: unknown,
): Promise<void> {
  const errorMessage = formatErrorMessage(err);
  const errorClass = err instanceof Error ? err.constructor.name : typeof err;
  // Errno-shaped transport signal (own-property, never message text) — fed
  // into both the persisted evidence below AND the bug-report `context`.
  const causeCode = readMissionErrorSignal(err).causeCode;
  // Log first — even if the DB write below fails, the failure stays visible.
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
        err,
        summary: errorMessage,
        evidenceBase: {
          errorMessage,
          errorClass,
          causeCode,
          occurredAt: new Date().toISOString(),
          missionId,
          runId,
        },
      },
      Date.now(),
    );
    await emitFinalizeControlState(sessionId, runId);
    // Enqueue the retry wake AFTER the persist commits. A failed/duplicate
    // enqueue leaves the run recoverable (no auto-resume) — never throws.
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
    // Phase 2 BUG-REPORTING emit (puzzle 03): persisting `paused_error`
    // is the canonical recoverable-failure surface — emit so support
    // records carry the error class + agent context. Fail-closed
    // through `emitBugReportSafe` so a support outage cannot mask the
    // original runtime failure.
    const { getBugReportSink } = await import(
      "../../support/bug-report-registry.js"
    );
    const { emitBugReportSafe } = await import(
      "../../../../lib/diagnostics/bug-report-sink.js"
    );
    await emitBugReportSafe(
      getBugReportSink(),
      {
        source: "agent",
        category: "mission_paused_error",
        severity: "error",
        title: `mission.${errorClass}`,
        description: errorMessage,
        refs: {
          sessionId,
          missionId,
          missionRunId: runId,
        },
        // `context` itself is `z.record(z.string(), z.unknown())` (unbounded;
        // `bug-report-schema.ts`) — redaction happens later in the bug-report
        // service. The VALUE stored under `causeCode` here is shape-validated
        // (errno-shaped, own-property-read — see `mission-error-signal.ts`),
        // never raw message text beyond what already flows through
        // `description`.
        context: { causeCode },
        agentContext: {
          stopReason: "provider_error",
          runtimeStatus: "paused_error",
        },
      },
      logger,
    );
  } catch (dbErr: unknown) {
    logger.error("engine.mission.paused_error_persist_failed", {
      runId,
      missionId,
      sessionId,
      dbError: dbErr instanceof Error ? dbErr.message : String(dbErr),
    });
    // Re-throw so the caller's catch path still trips the recoverable
    // throw — masking the persist failure would silently leave the run
    // in `running` while the user sees the error, recreating the very
    // orphan-state bug this module exists to fix.
    throw dbErr;
  }
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, ERROR_MESSAGE_LIMIT);
  return String(err).slice(0, ERROR_MESSAGE_LIMIT);
}
