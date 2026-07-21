/**
 * Operator-driven mission abort.
 *
 * Host-only API — NOT exposed to the model. Lives outside `mission_stop`
 * tool surface (`tools/internal/mission.ts:22`) on purpose: `mission_stop`
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
 *      itself to `cancelled` via `finalizeMissionRunStatus`) OR finalising
 *      directly when no controller is registered (paused states / out-of-
 *      process runs).
 *   4. The companion `resumeMissionRun` terminal guard now includes
 *      `cancelled`, and `approveAndResume` has a defensive pre-dispatch
 *      check that rejects when the active run is terminal.
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
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
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
  stopped: boolean;
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

  // (a) `running` with live in-process loop → fire AbortSignal. The loop checks
  // it at iteration and dispatch boundaries, then maps `user_stopped` to the
  // terminal `cancelled` status.
  if (run.status === "running" && controllers.has(runId)) {
    controllers.get(runId)!.abort();
    logger.info("engine.mission.abort_signaled", {
      runId,
      sessionId: run.sessionId,
    });
    return { aborted: true, finalStatus: "running", rejectedApprovals };
  }

  // (b) Paused states or out-of-process running → finalise directly using
  // the same status mapping the loop would have produced for `user_stopped`.
  await missionRunsRepo.updateStatus(runId, "cancelled", "user_stopped");
  await missionsRepo.setStatus(run.missionId, "cancelled");
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

  await loopWakeRepo.cancelForSession(run.sessionId, "user_edit");
  const rejectedApprovals = await rejectPendingApprovalsForSession(run.sessionId);
  if (rejectedApprovals > 0) {
    logger.info("engine.mission.edit_rejected_approvals", {
      runId,
      sessionId: run.sessionId,
      count: rejectedApprovals,
    });
  }

  if (run.status === "running" && controllers.has(runId)) {
    abortIntents.set(runId, "edit");
    controllers.get(runId)!.abort();
    logger.info("engine.mission.edit_abort_signaled", {
      runId,
      sessionId: run.sessionId,
    });
  }

  await missionRunsRepo.updateStatus(
    runId,
    "stopped",
    "user_stopped",
    { summary: "Mission stopped for operator edit" },
  );
  await missionsRepo.clearApprovedAt(run.missionId);
  await missionsRepo.setStatus(run.missionId, "draft");
  // A draft that was already complete before the stop-for-edit (e.g. the
  // operator just wanted to re-review, not change anything) would otherwise
  // sit at 'draft' forever — no model patch is coming to promote it.
  const reconciled = await reconcileDraftReadiness(run.missionId);
  logger.info("engine.mission.edit_finalized", {
    runId,
    sessionId: run.sessionId,
    previousStatus: run.status,
  });

  return {
    stopped: true,
    finalStatus: reconciled.promoted ? "ready" : "draft",
    rejectedApprovals,
  };
}
