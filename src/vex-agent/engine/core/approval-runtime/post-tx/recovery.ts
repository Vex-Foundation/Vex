/**
 * Approval runtime — post-tx recovery helpers (paused-error flip /
 * continuation-claim error kind).
 *
 * The snapshot tx in `../snapshot.ts` commits the queue+intent decision; the
 * post-tx side effects run AFTER that tx so an audit-write or dispatch failure
 * cannot roll back the decision itself. To prevent stranding the mission run
 * in `paused_approval` (decision resolved but no post-tx work completed),
 * every post-decision side effect is wrapped so a failure explicitly flips the
 * run to `paused_error` with audit evidence — the operator can `/retry` to
 * recover. These helpers are shared by the approve, dispatch-throw, reject, and
 * policy-drift side-effect paths.
 */

import * as missionRunsRepo from "../../../../db/repos/mission-runs.js";
import logger from "@utils/logger.js";

export const RESUME_CLAIM_ERROR_KIND = "ResumeClaimFailed";

/**
 * Transition the mission run to `paused_error` after a committed-decision
 * side effect fails. Best-effort: if the status update itself throws, log
 * structurally and continue — the original failure is already being
 * surfaced via the caller's thrown error.
 *
 * NEVER overwrites a terminal run. An operator Stop can land while a
 * post-decision side effect is still running, and a terminal run row is
 * immutable audit history: re-opening it as `paused_error` would erase the
 * user's stop and offer a `/retry` on a run whose approvals were already
 * rejected. The CAS lives in the repo (`updateStatusIfNotTerminal`).
 *
 * It also carries the DURABLE STOP CONSUMER (full rationale in
 * `runner/mission-auto-retry.ts`): the run parks here with no wake, so a
 * `stop_terminal` queued a moment ago would have no later reader. The gate runs
 * INSIDE the existing try/catch — this helper's never-throws contract is what
 * lets callers invoke it while a more important failure is already in flight.
 */
export interface FlipRunToPausedErrorInput {
  readonly approvalId: string;
  /** Required for the durable-Stop consumer — the boundary is session-keyed. */
  readonly sessionId: string;
  readonly missionRunId: string;
  readonly errorKind: string;
  readonly evidence: Record<string, unknown>;
}

export async function flipRunToPausedError(
  input: FlipRunToPausedErrorInput,
): Promise<void> {
  const { approvalId, sessionId, missionRunId, errorKind, evidence } = input;
  try {
    const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
      "../../../runtime/lease-and-status.js"
    );
    const outcome = await withSessionControlLock(sessionId, async (client) => {
      const gate = await gateOnOperatorStopWithClient(client, {
        sessionId,
        missionRunId,
      });
      // Fail-closed: a stopped run gets no park write at all.
      if (gate.kind === "stopped") return "stop_consumed" as const;
      const flipped = await missionRunsRepo.updateStatusIfNotTerminal(
        missionRunId,
        "paused_error",
        "approval_post_decision",
        { evidence: { approvalId, errorKind, ...evidence } },
        client,
      );
      return flipped ? ("flipped" as const) : ("superseded" as const);
    });
    if (outcome === "stop_consumed") {
      logger.info("engine.approval_runtime.paused_error_consumed_operator_stop", {
        approvalId,
        sessionId,
        missionRunId,
        errorKind,
      });
    } else if (outcome === "superseded") {
      logger.info("engine.approval_runtime.paused_error_skipped_terminal_run", {
        approvalId,
        missionRunId,
        errorKind,
      });
    }
  } catch (statusErr) {
    logger.warn("engine.approval_runtime.paused_error_update_failed", {
      approvalId,
      missionRunId,
      errorKind:
        statusErr instanceof Error
          ? statusErr.constructor.name
          : typeof statusErr,
    });
  }
}
