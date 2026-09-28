/**
 * Real BUSINESS OUTCOME finalisation: `goal_reached` -> `completed`,
 * every other terminating stop -> `failed`, written across the run row
 * and its parent mission row.
 */

import type { MissionStatus, StopReason } from "../../../types.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";
import { emitFinalizeControlState } from "./control-state-emit.js";
import { guardedWrite, type RunnerLeaseGuard } from "../../../runtime/lease-guard.js";

export async function finalizeBusinessOutcome(
  missionId: string,
  runId: string,
  sessionId: string,
  stopReason: StopReason,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
  leaseGuard?: RunnerLeaseGuard,
): Promise<MissionStatus> {
  const status: MissionStatus = stopReason === "goal_reached"
    ? "completed"
    : "failed";
  // TERMINAL-STOP PRECEDENCE for a real BUSINESS OUTCOME. `completed` and
  // `failed` do move a run TO terminal, which is the one case the
  // unconditional write exists for - but the outcome was decided by a
  // turn-loop result that is arbitrarily stale by the time it lands here, and
  // an operator Stop can have committed `stopped`/`user_stopped` in between.
  // A user who pressed Stop asked for the run to end THERE; overwriting that
  // with `completed` erases what they asked for and re-labels the audit row.
  // The Stop wins.
  //
  // The RUN transition goes first and the PARENT MISSION row is written ONLY
  // if it wins. The previous order (mission, then run) could mark the mission
  // `completed` even when the run write lost the race - the mission row and
  // its run row then disagreed about what happened.
  //
  // FENCED for a lease-holding runner: the run write and the mission write
  // commit together, and only while this runner's claim holds. A refused
  // write leaves both rows to the runner that owns the session now.
  if (leaseGuard !== undefined) {
    const fenced = await guardedWrite(
      leaseGuard,
      "mission_finalize",
      async (client) => {
        const won = await missionRunsRepo.updateStatusIfNotTerminal(
          runId,
          status,
          stopReason,
          stopPayload,
          client,
        );
        if (won) await missionsRepo.setStatus(missionId, status, client);
        return won;
      },
      { lockMissionRunId: runId },
    );
    if (!fenced.fenced) return "running";
    if (fenced.value) {
      await emitFinalizeControlState(sessionId, runId);
      return status;
    }
  }
  const landed = leaseGuard !== undefined
    ? false
    : await missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      status,
      stopReason,
      stopPayload,
    );
  if (!landed) {
    // The outcome is NOT silently dropped: it is recorded here as the one
    // durable statement this path may make. Writing it onto the run row
    // instead would mutate terminal audit history - the very thing this guard
    // exists to prevent - and the row already carries the truthful pair.
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
