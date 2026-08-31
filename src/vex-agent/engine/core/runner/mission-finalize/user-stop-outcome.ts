/**
 * Ordinary operator-stop terminal policy (`user_stopped`, no edit intent).
 *
 * Finalize-after-local-abort: the operator's Stop fired the in-process
 * AbortController, so the loop unwound before the iteration-boundary
 * observer could apply the queued request. Runs the SAME idempotent stop
 * transaction the observer runs - whichever path wins the race, the DB
 * ends up identical (run `stopped`/`user_stopped`, mission `cancelled`,
 * approvals rejected, wakes cancelled, request cleared). Idempotent: a
 * no-op when the observer already applied it.
 */

import type { MissionStatus } from "../../../types.js";
import { emitFinalizeControlState } from "./control-state-emit.js";

export async function finalizeUserStop(
  runId: string,
  sessionId: string,
  stopPayload?: { summary?: string; evidence?: Record<string, unknown> },
): Promise<MissionStatus> {
  const { applyUserStopTransaction } = await import(
    "../../../runtime/lease-and-status.js"
  );
  await applyUserStopTransaction({
    sessionId,
    missionRunId: runId,
    stopPayload,
  });
  await emitFinalizeControlState(sessionId, runId);
  // Mission-level terminal for an operator stop. `MissionStatus` has no
  // `stopped` arm; only the RUN row carries the canonical
  // `stopped` + `user_stopped` pair.
  return "cancelled";
}
