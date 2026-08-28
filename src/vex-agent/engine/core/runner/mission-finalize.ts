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
 *
 * THIS FILE IS THE ROUTING TABLE. Each terminal / park policy owns its own
 * module under `mission-finalize/`; the ORDER of the arms below is itself
 * part of the contract (an operator stop outranks every business outcome),
 * which is why the dispatch stays readable in one place. Both public entry
 * points keep this module path, so existing importers are unaffected.
 */

import type { MissionStatus, StopReason } from "../../types.js";
import { consumeMissionRunAbortIntent } from "./abort.js";
import { isContinuableRuntimeStop } from "./runtime-continuation.js";
import { finalizeStopForEdit } from "./mission-finalize/stop-for-edit-outcome.js";
import { finalizeUserStop } from "./mission-finalize/user-stop-outcome.js";
import { finalizeBusinessOutcome } from "./mission-finalize/business-outcome.js";
import { finalizeRuntimeContinuationPark } from "./mission-finalize/runtime-continuation-park.js";
import { finalizeSystemError } from "./mission-finalize/system-error-escalation.js";
import { finalizeOperatorReviewPark } from "./mission-finalize/operator-review-park.js";
import { finalizeToolCallLoopPark } from "./mission-finalize/tool-call-loop-park.js";

export { finalizeMissionRunError } from "./mission-finalize/error-pause.js";

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
      return finalizeStopForEdit(missionId, runId, sessionId, stopPayload);
    }

    if (stopReason === "user_stopped") {
      return finalizeUserStop(runId, sessionId, stopPayload);
    }

    return finalizeBusinessOutcome(
      missionId,
      runId,
      sessionId,
      stopReason,
      stopPayload,
    );
  }

  if (isContinuableRuntimeStop(stopReason)) {
    return finalizeRuntimeContinuationPark(
      missionId,
      runId,
      sessionId,
      stopReason,
    );
  }

  if (stopReason === "system_error") {
    return finalizeSystemError(missionId, runId, sessionId, stopPayload);
  }

  if (stopReason === "tool_call_loop") {
    return finalizeToolCallLoopPark(missionId, runId, sessionId, stopPayload);
  }

  if (stopReason === "compact_unable_at_critical" || stopReason === "no_progress") {
    return finalizeOperatorReviewPark(
      missionId,
      runId,
      sessionId,
      stopReason,
      stopPayload,
    );
  }

  return "running";
}
