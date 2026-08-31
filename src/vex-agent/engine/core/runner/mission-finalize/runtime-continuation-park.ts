/**
 * Continuable-runtime-stop park: the slice ran out of iterations or wall
 * clock, so the run is parked `paused_wake` / `waiting_for_wake` and an
 * automatic continuation is scheduled.
 *
 * Same TERMINAL-STOP PRECEDENCE rule as the operator-review park: parking
 * a run for a later wake is a RECOVERY write, decided from a turn-loop
 * outcome that is arbitrarily stale by the time it lands here, and it must
 * never re-open a run an operator Stop already took terminal.
 *
 * The wake is enqueued BEFORE the CAS and cancelled when the CAS refuses,
 * rather than enqueued after a successful CAS. That ordering is deliberate:
 * a Stop landing between a successful CAS and a later enqueue would leave a
 * continuation scheduled on a stopped run (the stop transaction's own wake
 * cancellation would already have run), which is worse than the status write
 * - the executor would wake the run back up. Enqueue-then-CAS-then-cancel
 * closes that window instead of moving it.
 */

import type { MissionStatus } from "../../../types.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import logger from "@utils/logger.js";
import {
  scheduleRuntimeContinuation,
  type ContinuableRuntimeStop,
} from "../runtime-continuation.js";

export async function finalizeRuntimeContinuationPark(
  missionId: string,
  runId: string,
  sessionId: string,
  stopReason: ContinuableRuntimeStop,
): Promise<MissionStatus> {
  const continuation = await scheduleRuntimeContinuation({
    sessionId,
    missionRunId: runId,
    trigger: stopReason,
  });
  // DURABLE STOP CONSUMER (full rationale in `mission-auto-retry.ts`). The
  // enqueue → park → cancel-if-lost ordering above is unchanged; only the park
  // itself moves under the session control lock, and a gate that reports
  // `stopped` is handled EXACTLY like a refused CAS below - including
  // cancelling the wake this arm just enqueued.
  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "../../../runtime/lease-and-status.js"
  );
  const parked = await withSessionControlLock(sessionId, async (client) => {
    const gate = await gateOnOperatorStopWithClient(client, {
      sessionId,
      missionRunId: runId,
    });
    // Fail-closed: a stopped run gets no park write at all.
    if (gate.kind === "stopped") return false;
    return missionRunsRepo.updateStatusIfNotTerminal(
      runId,
      "paused_wake",
      "waiting_for_wake",
      {
        summary: `${stopReason}: runtime slice exhausted; automatic continuation scheduled`,
        evidence: {
          trigger: stopReason,
          dueAt: continuation.dueAt,
          enqueued: continuation.enqueued,
        },
      },
      client,
    );
  });
  if (!parked) {
    // The run went terminal while the slice was unwinding (or the gate just
    // landed the operator's queued Stop). The row is
    // immutable audit history and was left untouched - but the wake this arm
    // just enqueued must not survive, or the executor resumes a stopped run.
    // Only cancel a wake WE enqueued: `enqueued === false` means a pending
    // wake already existed (partial unique index on session), and adopting
    // someone else's row is not this arm's call to make.
    if (continuation.enqueued) {
      const { cancelForSession } = await import(
        "@vex-agent/db/repos/loop-wake.js"
      );
      await cancelForSession(
        sessionId,
        `run ${runId} reached a terminal status before the ${stopReason} continuation could be parked`,
      );
    }
    logger.warn("engine.mission.runtime_continuation_after_terminal", {
      runId,
      missionId,
      sessionId,
      trigger: stopReason,
      wakeCancelled: continuation.enqueued,
    });
  }
  return "running";
}
