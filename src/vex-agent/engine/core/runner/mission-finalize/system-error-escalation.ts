/**
 * Terminal `system_error` escalation.
 *
 * Same TERMINAL-STOP PRECEDENCE and same run-before-mission ordering as the
 * business-outcome arm: `system_error` is a genuine terminal outcome, but a
 * Stop that already committed outranks it.
 */

import type { MissionStatus } from "../../../types.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";
import { emitFinalizeControlState } from "./control-state-emit.js";
import { emitMissionSystemErrorReport } from "./bug-report-emit.js";
import { guardedWrite, type RunnerLeaseGuard } from "../../../runtime/lease-guard.js";

export async function finalizeSystemError(
  missionId: string,
  runId: string,
  sessionId: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
  leaseGuard?: RunnerLeaseGuard,
): Promise<MissionStatus> {
  // Fenced for a lease-holding runner: run + mission rows commit together and
  // only while the claim holds (see `business-outcome.ts`).
  let landed: boolean;
  let missionWritten = false;
  if (leaseGuard !== undefined) {
    const fenced = await guardedWrite(
      leaseGuard,
      "mission_finalize",
      async (client) => {
        const won = await missionRunsRepo.updateStatusIfNotTerminal(
          runId,
          "failed",
          "system_error",
          undefined,
          client,
        );
        if (won) await missionsRepo.setStatus(missionId, "failed", client);
        return won;
      },
      { lockMissionRunId: runId },
    );
    if (!fenced.fenced) return "running";
    landed = fenced.value;
    missionWritten = fenced.value;
  } else {
    landed = await missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      "failed",
      "system_error",
    );
  }
  if (!landed) {
    logger.warn("engine.mission.outcome_superseded_by_terminal_stop", {
      runId,
      missionId,
      sessionId,
      supersededRunStatus: "failed",
      stopReason: "system_error",
    });
    await emitFinalizeControlState(sessionId, runId);
    // The bug report is deliberately skipped: its `runtimeStatus: "failed"`
    // would be a false statement about a run that is actually `stopped` -
    // the same rule `finalizeMissionRunError` applies on its terminal branch.
    // The warn above is the record that the escalation was superseded.
    return "cancelled";
  }
  if (!missionWritten) await missionsRepo.setStatus(missionId, "failed");
  await emitFinalizeControlState(sessionId, runId);
  await emitMissionSystemErrorReport(
    { sessionId, missionId, runId },
    stopPayload?.summary ?? "system_error terminal",
  );
  return "failed";
}
