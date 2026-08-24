/**
 * Post-batch handling for the `plan_pause` engine signal — a `PlanWrite` in an
 * active mission run created/changed a plan that is not user-accepted.
 *
 * Flips the mission run to `paused_plan_acceptance` with the
 * `plan_acceptance_required` stop reason. Resume is gated on plan ACCEPTANCE:
 * refused while the plan is unaccepted; once accepted it resumes via the
 * `plan.accept` IPC OR any control resume path. It is a RUNTIME_PAUSE but NOT a
 * RESUMABLE_STOP, so a plain user chat message never resumes it. Unlike
 * `waiting_for_wake` there is no forced-compact-before-wait — acceptance is a
 * user action, not a timed wake.
 *
 * The runner's `finally` (releaseLeaseAndEmitControlState) emits the resulting
 * control state, so no explicit emit is needed here (mirrors
 * `applyWaitingForWakePostBatch`).
 */

import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";

export async function applyPlanAcceptancePausePostBatch(args: {
  readonly sessionId: string;
  readonly missionRunId: string | null;
}): Promise<void> {
  const { sessionId, missionRunId } = args;
  // Chat sessions have no run row to park and no run-scoped stop to consume.
  if (missionRunId === null) return;

  // DURABLE STOP CONSUMER (full rationale in `runner/mission-auto-retry.ts`).
  // This park is the WORST case for a queued `stop_terminal`: unlike a wake
  // pause there is no timed self-heal at all — resume is gated on the user
  // ACCEPTING a plan — so a Stop queued after the loop's last iteration
  // checkpoint would sit `pending` until the operator accepted a plan on a run
  // they had already stopped. Gate + park commit together under the session
  // control lock so a Stop cannot slip between them.
  //
  // TERMINAL-STOP PRECEDENCE. Parking for plan acceptance is a RECOVERY
  // write — it never moves a run TO terminal — so it goes through the repo
  // CAS. An operator Stop can land while the batch unwinds; re-opening the
  // run into `paused_plan_acceptance` would both erase the stop and leave a
  // run the `plan.accept` IPC could resume.
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "@vex-agent/engine/runtime/lease-and-status.js"
  );
  const outcome = await withSessionControlLock(sessionId, async (client) => {
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId,
    });
    // Fail-closed: the gate only COMPLETES the stop; it never resumes or
    // dispatches anything. A stopped run gets no park write at all.
    if (gate.kind === "stopped") return "stop_consumed" as const;
    const parked = await missionRunsRepo.updateStatusIfNotTerminal(
      missionRunId,
      "paused_plan_acceptance",
      "plan_acceptance_required",
      undefined,
      client,
    );
    return parked ? ("parked" as const) : ("superseded" as const);
  });
  if (outcome === "stop_consumed") {
    logger.info("engine.mission.plan_acceptance_pause_consumed_operator_stop", {
      sessionId,
      runId: missionRunId,
    });
  } else if (outcome === "superseded") {
    logger.warn("engine.mission.pause_after_terminal", {
      runId: missionRunId,
      pauseStatus: "paused_plan_acceptance",
    });
  }
}
