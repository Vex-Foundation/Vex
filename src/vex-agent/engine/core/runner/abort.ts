/**
 * Operator-driven mission abort.
 *
 * Host-only API — NOT exposed to the model. Lives outside `MissionStop`
 * tool surface (`tools/internal/mission.ts:22`) on purpose: `MissionStop`
 * with `reason="user_stopped"` is rejected by design (`mission.test.ts:78`)
 * because that reason is reserved for the operator path. This module is the
 * operator path.
 *
 * Cleanup invariant: after `abortMissionRun(runId)` resolves successfully,
 * NO future `approveAndResume` for that session can dispatch a tool. We get
 * that by:
 *   1. Cancelling pending wakes for the session (defensive — wake executor
 *      may already be claiming a `paused_wake` row when we fire).
 *   2. Rejecting every `pending` approval whose `session_id` matches the
 *      run's session. `approveAndResume` CAS in `approvalsRepo.approve`
 *      then fails because the row is no longer `pending`.
 *   3. Either firing the in-process `AbortSignal` (live loop, status drives
 *      itself to the canonical stop via `finalizeMissionRunStatus`) OR
 *      finalising directly when no controller is registered (paused states /
 *      out-of-process runs).
 *   4. The companion `resumeMissionRun` terminal guard now includes
 *      `cancelled`, and `approveAndResume` has a defensive pre-dispatch
 *      check that rejects when the active run is terminal.
 *
 * Canonical user-stop terminal state: the direct-finalise path runs the SAME
 * `applyUserStopTransaction` the observer and finalize paths run, so a run
 * stopped by the operator always lands on `stopped` + `user_stopped` (the
 * parent mission on `cancelled`), never a second spelling.
 *
 * Multi-process note: the `AbortController` registry below is per-process.
 * If two processes run the same engine (e.g. a dev host and the desktop app),
 * only the process that started/resumed the run can deliver the signal
 * cleanly. The DB-direct fall-through finalises the row for the other
 * process — race window is one in-flight turn — so either path leaves the
 * run terminal in DB. Cross-process abort signalling would need pub/sub
 * (Postgres LISTEN/NOTIFY or polling), which is out of scope.
 */

import { type MissionStatus, TERMINAL_RUN_STATUSES } from "../../types.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as loopWakeRepo from "@vex-agent/db/repos/loop-wake.js";
import logger from "@utils/logger.js";
import { rejectPendingApprovalsForSession } from "./approvals-cleanup.js";
import { reconcileDraftReadiness } from "../../mission/draft-readiness.js";

// ── In-process AbortController registry ─────────────────────────

const controllers = new Map<string, AbortController>();
const abortIntents = new Map<string, "edit">();

/**
 * Hosts (`startMission`, `resumeMissionRun`) call this to obtain a controller
 * they MUST pass to `runTurnLoop`. Returns the existing controller if a
 * register call has already happened for this `runId` in this process — a
 * resume re-entry then sees the same signal as a concurrent abort caller.
 */
export function registerMissionRunAbortController(runId: string): AbortController {
  let c = controllers.get(runId);
  if (!c) {
    c = new AbortController();
    controllers.set(runId, c);
  }
  return c;
}

/** Hosts MUST call this in `finally` after `runTurnLoop` returns. */
export function unregisterMissionRunAbortController(runId: string): void {
  controllers.delete(runId);
}

export function hasMissionRunAbortController(runId: string): boolean {
  return controllers.has(runId);
}

/**
 * Fire the in-process `AbortController` for `runId` if THIS process holds
 * one. Writes nothing — the durable control request is the caller's
 * responsibility and must already be persisted before this is called, so a
 * crash between the two leaves the durable truth intact.
 *
 * This is what makes the IPC Stop button cancel an in-flight provider call
 * instead of waiting for the next iteration boundary: Electron main hosts the
 * engine in-process, so the registry is reachable from the IPC handler.
 * Returns `false` when no controller is registered (paused run, or the run
 * lives in another process) — the caller then relies on the durable request
 * or the direct abort path.
 */
export function signalMissionRunAbortLocal(runId: string): boolean {
  const controller = controllers.get(runId);
  if (controller === undefined) return false;
  controller.abort();
  return true;
}

export function consumeMissionRunAbortIntent(runId: string): "edit" | null {
  const intent = abortIntents.get(runId) ?? null;
  abortIntents.delete(runId);
  return intent;
}

// ── Public API ──────────────────────────────────────────────────

export interface AbortMissionRunResult {
  /**
   * `true` when the call changed state — either the in-process loop was
   * signalled OR the run was finalised directly. `false` for already-terminal
   * runs (no-op).
   */
  aborted: boolean;
  /**
   * Mission status after the call. May still be `"running"` if we only
   * fired the AbortSignal — the live loop finalises asynchronously to
   * `"cancelled"` once the next iteration check fires.
   */
  finalStatus: MissionStatus;
  /** Number of pending approvals rejected as part of this abort. */
  rejectedApprovals: number;
}

export interface StopMissionRunForEditResult {
  /**
   * `true` only when the operator's edit is in effect — either THIS call
   * performed the stop-for-edit transition, or the sibling finalize path did
   * it first for the same intent. `false` means the edit LOST to a committed
   * ordinary Stop (or another terminal outcome): nothing was written, the
   * mission stayed `cancelled`, and the caller must report that truthfully
   * rather than a successful edit.
   */
  stopped: boolean;
  /** The parent mission's real status after the call — never a guess. */
  finalStatus: MissionStatus;
  rejectedApprovals: number;
}

/**
 * Abort an active mission run. Operator-driven; safe to call concurrently
 * with the live loop. See module docstring for the cleanup invariant.
 */
export async function abortMissionRun(runId: string): Promise<AbortMissionRunResult> {
  const run = await missionRunsRepo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { aborted: false, finalStatus: run.status as MissionStatus, rejectedApprovals: 0 };
  }

  // Defensive even for `running`: wake executor could be about to claim a
  // `paused_wake` row that just raced us. Cheap no-op when nothing pending.
  await loopWakeRepo.cancelForSession(run.sessionId, "user_aborted");

  const rejectedApprovals = await rejectPendingApprovalsForSession(run.sessionId);
  if (rejectedApprovals > 0) {
    logger.info("engine.mission.abort_rejected_approvals", {
      runId,
      sessionId: run.sessionId,
      count: rejectedApprovals,
    });
  }

  // (a) `running` with live in-process loop → fire AbortSignal. The signal
  // now also cancels the in-flight inference (mission-run.ts threads it as
  // BOTH the boundary and the inference signal), so the loop unwinds
  // immediately, sets `stopReason = "user_stopped"` and lets
  // `finalizeMissionRunStatus` run the shared stop transaction.
  if (run.status === "running" && signalMissionRunAbortLocal(runId)) {
    logger.info("engine.mission.abort_signaled", {
      runId,
      sessionId: run.sessionId,
    });
    return { aborted: true, finalStatus: "running", rejectedApprovals };
  }

  // (b) Paused states or out-of-process running → finalise directly through
  // the SHARED stop transaction, so this path and the loop's own finalize
  // leave byte-identical state.
  const { applyUserStopTransaction } = await import(
    "../../runtime/lease-and-status.js"
  );
  const applied = await applyUserStopTransaction({
    sessionId: run.sessionId,
    missionRunId: runId,
  });
  if (applied.outcome !== "stopped") {
    // Raced to terminal (or the row vanished) between our read and the lock.
    logger.info("engine.mission.abort_already_terminal", {
      runId,
      sessionId: run.sessionId,
      outcome: applied.outcome,
    });
    return { aborted: false, finalStatus: "cancelled", rejectedApprovals };
  }
  logger.info("engine.mission.abort_finalized_directly", {
    runId,
    sessionId: run.sessionId,
    previousStatus: run.status,
  });
  return { aborted: true, finalStatus: "cancelled", rejectedApprovals };
}

/** Resolve the active run for the session, then abort it. */
export async function abortActiveMissionForSession(
  sessionId: string,
): Promise<AbortMissionRunResult | null> {
  const activeRun = await missionRunsRepo.getActiveRunBySession(sessionId);
  if (!activeRun) return null;
  return abortMissionRun(activeRun.id);
}

/**
 * Stop the active run so the operator can edit the mission contract.
 *
 * This is intentionally distinct from `abortMissionRun`: the run is terminal,
 * but the parent mission returns to `draft` instead of `cancelled`, so the
 * operator can save an updated draft and start a fresh run.
 *
 * A committed ordinary Stop OUTRANKS this. The whole transition (run row +
 * mission demotion) lives in `applyStopForEditTransaction`, which gates the
 * demotion on winning the run transition under the run row lock — see that
 * module for why the winner cannot be identified from the status value.
 */
export async function stopActiveMissionForEdit(
  sessionId: string,
): Promise<StopMissionRunForEditResult | null> {
  const activeRun = await missionRunsRepo.getActiveRunBySession(sessionId);
  if (!activeRun) return null;
  return stopMissionRunForEdit(activeRun.id);
}

export async function stopMissionRunForEdit(
  runId: string,
): Promise<StopMissionRunForEditResult> {
  const run = await missionRunsRepo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);

  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return {
      stopped: false,
      finalStatus: run.status as MissionStatus,
      rejectedApprovals: 0,
    };
  }

  // Defensive: the wake executor could be about to claim a `paused_wake` row.
  // The transition below cancels the session's wakes inside its transaction as
  // well; this only shortens the window before it.
  await loopWakeRepo.cancelForSession(run.sessionId, "user_edit");

  const abortSignalled = run.status === "running" && controllers.has(runId);
  if (abortSignalled) {
    abortIntents.set(runId, "edit");
    controllers.get(runId)!.abort();
    logger.info("engine.mission.edit_abort_signaled", {
      runId,
      sessionId: run.sessionId,
    });
  }

  const { applyStopForEditTransaction } = await import(
    "../../runtime/lease-and-status.js"
  );
  const applied = await applyStopForEditTransaction({
    sessionId: run.sessionId,
    missionRunId: runId,
  });

  if (applied.outcome === "run_not_found") {
    return { stopped: false, finalStatus: "cancelled", rejectedApprovals: 0 };
  }

  if (applied.outcome === "lost_to_terminal") {
    // OWNER DECISION: a committed user Stop is FINAL. We wrote nothing, the
    // mission keeps whatever terminal state the winner gave it, and the caller
    // reports that instead of a successful edit.
    logger.info("engine.mission.edit_lost_to_terminal_stop", {
      runId,
      sessionId: run.sessionId,
      runStatus: applied.currentRunStatus,
      missionStatus: applied.missionStatus,
    });
    return {
      stopped: false,
      finalStatus: applied.missionStatus,
      rejectedApprovals: 0,
    };
  }

  if (applied.outcome === "already_edited") {
    // The loop we just signalled unwound and ran the finalize edit arm before
    // this transaction got the run lock. The edit IS in effect — reporting a
    // loss here would be as untruthful as reporting a win after a real Stop.
    return {
      stopped: true,
      finalStatus: applied.missionStatus,
      rejectedApprovals: 0,
    };
  }

  if (applied.rejectedApprovals > 0) {
    logger.info("engine.mission.edit_rejected_approvals", {
      runId,
      sessionId: run.sessionId,
      count: applied.rejectedApprovals,
    });
  }
  // A draft that was already complete before the stop-for-edit (e.g. the
  // operator just wanted to re-review, not change anything) would otherwise
  // sit at 'draft' forever — no model patch is coming to promote it.
  const reconciled = await reconcileDraftReadiness(applied.missionId);
  logger.info("engine.mission.edit_finalized", {
    runId,
    sessionId: run.sessionId,
    previousStatus: applied.previousStatus,
  });

  return {
    stopped: true,
    finalStatus: reconciled.promoted ? "ready" : "draft",
    rejectedApprovals: applied.rejectedApprovals,
  };
}
