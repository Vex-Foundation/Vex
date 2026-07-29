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
 * sees the canonical terminal status (an operator stop lands on
 * `stopped` / `user_stopped`) and the lease cleared. Wraps a DB re-read
 * for canonical state.
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
      // ONE atomic, lock-aware transition, shared with `abort.ts`. The mission
      // demotion is gated on WINNING the run transition, so an ordinary Stop
      // that committed while this loop was unwinding is never overwritten and
      // its `cancelled` mission is never resurrected into `draft`.
      const { applyStopForEditTransaction } = await import(
        "../../runtime/lease-and-status.js"
      );
      const applied = await applyStopForEditTransaction({
        sessionId,
        missionRunId: runId,
        ...(stopPayload !== undefined ? { stopPayload } : {}),
      });
      await emitFinalizeControlState(sessionId, runId);
      if (applied.outcome === "stopped_for_edit") {
        // The async finalizer runs AFTER `stopMissionRunForEdit` already
        // reconciled once (abort.ts) — this demote-then-finalize sequence is
        // exactly the timing window issue #41 needs closed at every write
        // site, not just the first one.
        const reconciled = await reconcileDraftReadiness(applied.missionId);
        return reconciled.promoted ? "ready" : "draft";
      }
      if (applied.outcome === "run_not_found") return "cancelled";
      if (applied.outcome === "lost_to_terminal") {
        logger.warn("engine.mission.edit_superseded_by_terminal_stop", {
          runId,
          missionId,
          sessionId,
          runStatus: applied.currentRunStatus,
          missionStatus: applied.missionStatus,
        });
      }
      // Either the sibling `abort.ts` transaction already landed this edit, or
      // an ordinary Stop won. Report the mission row's REAL status either way.
      return applied.missionStatus;
    }

    if (stopReason === "user_stopped") {
      // Finalize-after-local-abort: the operator's Stop fired the in-process
      // AbortController, so the loop unwound before the iteration-boundary
      // observer could apply the queued request. Run the SAME idempotent
      // stop transaction the observer runs — whichever path wins the race,
      // the DB ends up identical (run `stopped`/`user_stopped`, mission
      // `cancelled`, approvals rejected, wakes cancelled, request cleared).
      // Idempotent: a no-op when the observer already applied it.
      const { applyUserStopTransaction } = await import(
        "../../runtime/lease-and-status.js"
      );
      await applyUserStopTransaction({
        sessionId,
        missionRunId: runId,
        stopPayload,
      });
      await emitFinalizeControlState(sessionId, runId);
      // Mission-level terminal for an operator stop. `MissionStatus` has no
      // `stopped` arm; only the RUN row carries the canonical
      // `stopped` + `user_stopped` pair.
      return "cancelled";
    }

    const status: MissionStatus = stopReason === "goal_reached"
      ? "completed"
      : "failed";
    // TERMINAL-STOP PRECEDENCE for a real BUSINESS OUTCOME. `completed` and
    // `failed` do move a run TO terminal, which is the one case the
    // unconditional write exists for — but the outcome was decided by a
    // turn-loop result that is arbitrarily stale by the time it lands here, and
    // an operator Stop can have committed `stopped`/`user_stopped` in between.
    // A user who pressed Stop asked for the run to end THERE; overwriting that
    // with `completed` erases what they asked for and re-labels the audit row.
    // The Stop wins.
    //
    // The RUN transition goes first and the PARENT MISSION row is written ONLY
    // if it wins. The previous order (mission, then run) could mark the mission
    // `completed` even when the run write lost the race — the mission row and
    // its run row then disagreed about what happened.
    const landed = await missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      status,
      stopReason,
      stopPayload,
    );
    if (!landed) {
      // The outcome is NOT silently dropped: it is recorded here as the one
      // durable statement this path may make. Writing it onto the run row
      // instead would mutate terminal audit history — the very thing this guard
      // exists to prevent — and the row already carries the truthful pair.
      logger.warn("engine.mission.outcome_superseded_by_terminal_stop", {
        runId,
        missionId,
        sessionId,
        supersededRunStatus: status,
        stopReason,
      });
      await emitFinalizeControlState(sessionId, runId);
      // `cancelled` is the mission-level terminal an operator stop writes (the
      // stop transaction already set it). Returning the superseded outcome
      // would report a mission as completed when the DB says it was stopped.
      return "cancelled";
    }
    await missionsRepo.setStatus(missionId, status);
    await emitFinalizeControlState(sessionId, runId);
    return status;
  }

  // Same TERMINAL-STOP PRECEDENCE rule as the `compact_unable_at_critical` arm
  // below: parking a run for a later wake is a RECOVERY write, decided from a
  // turn-loop outcome that is arbitrarily stale by the time it lands here, and
  // it must never re-open a run an operator Stop already took terminal.
  //
  // The wake is enqueued BEFORE the CAS and cancelled when the CAS refuses,
  // rather than enqueued after a successful CAS. That ordering is deliberate:
  // a Stop landing between a successful CAS and a later enqueue would leave a
  // continuation scheduled on a stopped run (the stop transaction's own wake
  // cancellation would already have run), which is worse than the status write
  // — the executor would wake the run back up. Enqueue-then-CAS-then-cancel
  // closes that window instead of moving it.
  if (isContinuableRuntimeStop(stopReason)) {
    const continuation = await scheduleRuntimeContinuation({
      sessionId,
      missionRunId: runId,
      trigger: stopReason,
    });
    // DURABLE STOP CONSUMER (full rationale in `mission-auto-retry.ts`). The
    // enqueue → park → cancel-if-lost ordering above is unchanged; only the park
    // itself moves under the session control lock, and a gate that reports
    // `stopped` is handled EXACTLY like a refused CAS below — including
    // cancelling the wake this arm just enqueued.
    const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
      "../../runtime/lease-and-status.js"
    );
    const parked = await withSessionControlLock(sessionId, async (client) => {
      const gate = await gateOnOperatorStopWithClient(client, {
        sessionId,
        missionRunId: runId,
      });
      // Fail-closed: a stopped run gets no park write at all.
      if (gate.kind === "stopped") return false;
      return missionRunsRepo.updateStatusIfNotTerminal(
        runId,
        "paused_wake",
        "waiting_for_wake",
        {
          summary: `${stopReason}: runtime slice exhausted; automatic continuation scheduled`,
          evidence: {
            trigger: stopReason,
            dueAt: continuation.dueAt,
            enqueued: continuation.enqueued,
          },
        },
        client,
      );
    });
    if (!parked) {
      // The run went terminal while the slice was unwinding (or the gate just
      // landed the operator's queued Stop). The row is
      // immutable audit history and was left untouched — but the wake this arm
      // just enqueued must not survive, or the executor resumes a stopped run.
      // Only cancel a wake WE enqueued: `enqueued === false` means a pending
      // wake already existed (partial unique index on session), and adopting
      // someone else's row is not this arm's call to make.
      if (continuation.enqueued) {
        const { cancelForSession } = await import(
          "@vex-agent/db/repos/loop-wake.js"
        );
        await cancelForSession(
          sessionId,
          `run ${runId} reached a terminal status before the ${stopReason} continuation could be parked`,
        );
      }
      logger.warn("engine.mission.runtime_continuation_after_terminal", {
        runId,
        missionId,
        sessionId,
        trigger: stopReason,
        wakeCancelled: continuation.enqueued,
      });
    }
    return "running";
  }

  if (stopReason === "system_error") {
    // Same TERMINAL-STOP PRECEDENCE and same run-before-mission ordering as the
    // business-outcome arm above: `system_error` is a genuine terminal outcome,
    // but a Stop that already committed outranks it.
    const landed = await missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      "failed",
      stopReason,
    );
    if (!landed) {
      logger.warn("engine.mission.outcome_superseded_by_terminal_stop", {
        runId,
        missionId,
        sessionId,
        supersededRunStatus: "failed",
        stopReason,
      });
      await emitFinalizeControlState(sessionId, runId);
      // The bug report is deliberately skipped: its `runtimeStatus: "failed"`
      // would be a false statement about a run that is actually `stopped` —
      // the same rule `finalizeMissionRunError` applies on its terminal branch.
      // The warn above is the record that the escalation was superseded.
      return "cancelled";
    }
    await missionsRepo.setStatus(missionId, "failed");
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
  //
  // TERMINAL-STOP PRECEDENCE. This is the LAST write in the escalation chain,
  // so it — not the turn-loop helper that decided to escalate — is what the run
  // row ends up carrying. The decision itself is arbitrarily stale by the time
  // it lands here: `maybeRunForcedCompactFallback` is an await that can span a
  // whole forced compaction, and an operator Stop can land terminally at any
  // point inside it, INCLUDING after the helper's own CAS already succeeded.
  // Guarding only the earlier write is therefore not enough — whichever write
  // is last decides, so every write in the chain goes through the one repo CAS
  // that owns this invariant (`updateStatusIfNotTerminal`). The unconditional
  // `updateStatus` is reserved for writes that legitimately move a run TO a
  // terminal state; a park/recovery write must never move one back out. A
  // terminal user stop outranks every other terminal state.
  if (stopReason === "compact_unable_at_critical") {
    // DURABLE STOP CONSUMER (see `mission-auto-retry.ts` for the full
    // rationale). Parking here reaches `paused_error` with NO wake, so this is
    // the last iteration boundary the run will ever have: a `stop_terminal`
    // request still queued at this point would be stranded until the operator
    // clicked Stop a second time. Gate + park commit together under the
    // session control lock so a Stop cannot slip between them.
    const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
      "../../runtime/lease-and-status.js"
    );
    const parked = await withSessionControlLock(sessionId, async (client) => {
      const gate = await gateOnOperatorStopWithClient(client, {
        sessionId,
        missionRunId: runId,
      });
      // Fail-closed: the gate only COMPLETES the stop; it never resumes or
      // dispatches anything. A stopped run gets no park write at all.
      if (gate.kind === "stopped") return false;
      return missionRunsRepo.updateStatusIfNotTerminal(
        runId,
        "paused_error",
        stopReason,
        {
          summary: stopPayload?.summary ?? "Two consecutive forced-fallback noops at critical pressure — operator review required.",
          evidence: stopPayload?.evidence,
        },
        client,
      );
    });
    if (!parked) {
      // The run reached a terminal status while the compaction was awaited —
      // in practice an operator Stop, whose own transaction already set the
      // mission row. Nothing was written here and nothing may be: a terminal
      // run row is immutable audit history. The return value describes what
      // THIS arm did to the mission row (nothing, on both branches), which is
      // why it is unchanged; the warn log is the record that the escalation
      // was superseded.
      logger.warn("engine.mission.compact_unable_at_critical_after_terminal", {
        runId,
        missionId,
        sessionId,
      });
    }
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
        sessionId,
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
    if (!decision.persisted) {
      // The run was already TERMINAL under the row lock — almost always an
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
