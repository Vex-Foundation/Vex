/**
 * `runPreparedMissionRecover` — long-running half of the recover
 * pipeline. All dependencies are in `prepared`; no fallible re-fetch
 * before the protected resume path.
 *
 * Recovery banner is best-effort (outside the durable section), so a
 * banner append failure does NOT roll back the durable
 * `mission_runs` row that `prepareMissionRecover` already committed.
 */

import { appendEngineMessage } from "@vex-agent/engine/events/index.js";
import logger from "@utils/logger.js";

import { resumePreparedMissionRun } from "./mission-run.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import type { PreparedMissionRecover } from "./recover-prepare.js";
import type { TurnResult } from "../../types.js";

function buildRecoveryBanner(prepared: PreparedMissionRecover): string {
  return [
    "[Engine: mission_recovered — The operator requested recovery from a failed mission run.",
    "This is a new run using the failed run's frozen Mission Contract.",
    "The old failed run remains terminal audit history. Execute the recovered Mission Contract now.]",
  ].join(" ");
}

export async function runPreparedMissionRecover(
  prepared: PreparedMissionRecover,
): Promise<TurnResult> {
  try {
    // Banner — best-effort. A failure here does NOT unwind the
    // dispatched recovery (mission_runs row + status are already
    // committed by `prepareMissionRecover`).
    await appendEngineMessage(prepared.sessionId, buildRecoveryBanner(prepared), {
      source: "engine",
      messageType: "mission_recovered",
      visibility: "internal",
      payload: {
        missionId: prepared.missionId,
        recoveredRunId: prepared.newRunId,
        recoveredFromRunId: prepared.recoveredFromRunId,
      },
    }).catch((err) => {
      logger.warn("engine.mission.recover.banner_append_failed", {
        sessionId: prepared.sessionId,
        missionId: prepared.missionId,
        runId: prepared.newRunId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    return await resumePreparedMissionRun({
      runId: prepared.newRunId,
      runnerOwnerId: prepared.sessionLease.ownerId,
      run: prepared.run,
      mission: prepared.mission,
      provider: prepared.provider,
      config: prepared.config,
    });
  } finally {
    await releaseLeaseAndEmitControlState(
      prepared.sessionLease,
      prepared.sessionId,
      { missionRunId: prepared.newRunId },
    );
    // A recovered run is a lease-releasing turn like any other; the end-of-turn
    // resume hook fires inside the helper above, so an approval resolved while
    // it was running gets the sub-second resume instead of the retry ladder.
  }
}
