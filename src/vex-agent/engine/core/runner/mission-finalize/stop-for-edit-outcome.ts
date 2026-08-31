/**
 * Stop-for-edit terminal policy.
 *
 * The operator stopped the run in order to EDIT the mission, so the parent
 * mission row is demoted back to `draft` / `ready` instead of `cancelled`.
 * Reached only when the run's abort intent was `edit` (consumed by the
 * caller before this arm runs).
 */

import type { MissionStatus } from "../../../types.js";
import logger from "@utils/logger.js";
import { reconcileDraftReadiness } from "../../../mission/draft-readiness.js";
import { emitFinalizeControlState } from "./control-state-emit.js";

export async function finalizeStopForEdit(
  missionId: string,
  runId: string,
  sessionId: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
): Promise<MissionStatus> {
  // ONE atomic, lock-aware transition, shared with `abort.ts`. The mission
  // demotion is gated on WINNING the run transition, so an ordinary Stop
  // that committed while this loop was unwinding is never overwritten and
  // its `cancelled` mission is never resurrected into `draft`.
  const { applyStopForEditTransaction } = await import(
    "../../../runtime/lease-and-status.js"
  );
  const applied = await applyStopForEditTransaction({
    sessionId,
    missionRunId: runId,
    ...(stopPayload !== undefined ? { stopPayload } : {}),
  });
  await emitFinalizeControlState(sessionId, runId);
  if (applied.outcome === "stopped_for_edit") {
    // The async finalizer runs AFTER `stopMissionRunForEdit` already
    // reconciled once (abort.ts) - this demote-then-finalize sequence is
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
