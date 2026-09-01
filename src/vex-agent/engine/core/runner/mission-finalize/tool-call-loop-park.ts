/**
 * No-wake park for `tool_call_loop`: the model repeated the same completed
 * tool call after already being corrected once, so the run stops for a human.
 *
 * ## Why this is its own arm and not a branch of the operator-review park
 *
 * `operator-review-park.ts` covers two stops that share one story: the run
 * cannot make forward progress ON ITS OWN and nothing about it ran. This one
 * has a different story and a different piece of user-facing truth in it -
 * the repeated calls DID execute, up to the correction. Any copy that implies
 * an inert run would be false about a run that may have signed, broadcast or
 * spent something on each pass of the cycle. That difference is exactly why
 * the renderer refuses one-click retry for this cause, and a shared arm with a
 * ternary on the summary would have buried the reason for it.
 *
 * ## Why it must exist at all
 *
 * Without a guarded arm here, `tool_call_loop` falls through
 * `finalizeMissionRunStatus` to its `return "running"` default: the run row
 * stays `running` with no wake and no lease, an orphan the operator can
 * neither resume nor see a reason for. It is equally not a CONTINUABLE stop -
 * a scheduled continuation would wake the model into the identical state that
 * just produced the repetition, which is the loop with extra steps.
 *
 * TERMINAL-STOP PRECEDENCE. Like every other park in this family, the write
 * goes through `updateStatusIfNotTerminal` under the session control lock,
 * with the operator-stop gate consumed in the same transaction. A park write
 * must never move a run back out of a terminal state, and a `stop_terminal`
 * queued at this point would otherwise be stranded: parking here reaches
 * `paused_error` with NO wake, so this is the last iteration boundary the run
 * will ever have.
 */

import type { MissionStatus } from "../../../types.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";

/**
 * Truthful default when the batch did not supply its own summary. It names the
 * repetition and the correction (so "just retry it" is visibly not the answer)
 * and it does NOT claim the run did nothing.
 */
const TOOL_CALL_LOOP_SUMMARY =
  "The agent repeated the same tool call with the same result, was corrected once, and "
  + "repeated it again - so the run was stopped instead of continuing to spend on it. The "
  + "calls before the stop did execute; review the transcript before re-running.";

export async function finalizeToolCallLoopPark(
  missionId: string,
  runId: string,
  sessionId: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
): Promise<MissionStatus> {
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "../../../runtime/lease-and-status.js"
  );
  const parked = await withSessionControlLock(sessionId, async (client) => {
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId: runId,
    });
    // Fail-closed: the gate only COMPLETES the stop; it never resumes or
    // dispatches anything. A stopped run gets no park write at all.
    if (gate.kind === "stopped") return false;
    return missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      "paused_error",
      "tool_call_loop",
      {
        summary: stopPayload?.summary ?? TOOL_CALL_LOOP_SUMMARY,
        // The batch's evidence carries the SHAPE of the repetition (tool name,
        // cycle length, repeat count, call ids) and never the arguments - see
        // `runner/tool-call-loop-detector.ts`.
        evidence: stopPayload?.evidence,
      },
      client,
    );
  });
  if (!parked) {
    // The run reached a terminal status while the batch was unwinding - in
    // practice an operator Stop, whose own transaction already set the mission
    // row. Nothing was written here and nothing may be: a terminal run row is
    // immutable audit history.
    logger.warn("engine.mission.tool_call_loop_park_after_terminal", {
      runId,
      missionId,
      sessionId,
    });
  }
  return "running";
}
