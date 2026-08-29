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

export async function finalizeSystemError(
  missionId: string,
  runId: string,
  sessionId: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
): Promise<MissionStatus> {
  const landed = await missionRunsRepo.updateStatusIfNotTerminal(
    runId,
    "failed",
    "system_error",
  );
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
  await missionsRepo.setStatus(missionId, "failed");
  await emitFinalizeControlState(sessionId, runId);
  await emitMissionSystemErrorReport(
    { sessionId, missionId, runId },
    stopPayload?.summary ?? "system_error terminal",
  );
  return "failed";
}
