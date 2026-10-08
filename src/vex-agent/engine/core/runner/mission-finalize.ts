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
import type { RunnerLeaseGuard } from "../../runtime/lease-guard.js";
import logger from "@utils/logger.js";
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

/** Options every finalize entry point accepts. */
export interface FinalizeOptions {
  /**
   * The lease the finalizing runner holds. When present, the non-Stop arms
   * write the run state only while the claim still holds (`db/lease-fence.ts`),
   * and a runner whose lease was taken over writes nothing at all - the run
   * belongs to the new owner. Absent ⇒ exactly the previous behaviour.
   */
  readonly leaseGuard?: RunnerLeaseGuard;
}

/**
 * The stale-runner short circuit shared by both entry points: a `lease_lost`
 * outcome, or a claim KNOWN to be taken over, writes no run state. The
 * operator Stop is exempt - it is the user's authority over the run, not the
 * runner's, and its own transaction releases whatever lease exists.
 */
export function finalizeSkippedForLease(
  sessionId: string,
  runId: string,
  stopReason: StopReason | null,
  opts: FinalizeOptions | undefined,
): boolean {
  if (stopReason === "user_stopped") return false;
  const takenOver = opts?.leaseGuard?.lostReason() === "taken_over";
  if (stopReason !== "lease_lost" && !takenOver) return false;
  logger.warn("runtime.lease.finalize_skipped", {
    sessionId,
    runId,
    stopReason,
    reason: opts?.leaseGuard?.lostReason() ?? null,
  });
  return true;
}

export async function finalizeMissionRunStatus(
  missionId: string,
  runId: string,
  sessionId: string,
  stopReason: StopReason | null,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
  opts?: FinalizeOptions,
): Promise<MissionStatus> {
  if (!stopReason) return "running";
  // A stale runner reports the run as still running: it is, under its new owner.
  if (finalizeSkippedForLease(sessionId, runId, stopReason, opts)) return "running";
  const fence = opts?.leaseGuard;

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
      fence,
    );
  }

  if (isContinuableRuntimeStop(stopReason)) {
    return finalizeRuntimeContinuationPark(
      missionId,
      runId,
      sessionId,
      stopReason,
      fence,
    );
  }

  if (stopReason === "system_error") {
    return finalizeSystemError(missionId, runId, sessionId, stopPayload, fence);
  }

  if (stopReason === "tool_call_loop") {
    return finalizeToolCallLoopPark(missionId, runId, sessionId, stopPayload, fence);
  }

  if (stopReason === "compact_unable_at_critical" || stopReason === "no_progress") {
    return finalizeOperatorReviewPark(
      missionId,
      runId,
      sessionId,
      stopReason,
      stopPayload,
      fence,
    );
  }

  return "running";
}
