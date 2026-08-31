/**
 * Post-finalize control-state broadcast (puzzle 03).
 *
 * Codex review acceptance: turn-loop emits at observe time with the
 * still-active lease; this helper fires AFTER finalize so the renderer
 * sees the canonical terminal status (an operator stop lands on
 * `stopped` / `user_stopped`) and the lease cleared. Wraps a DB re-read
 * for canonical state.
 *
 * Owned by the finalize family and consumed by every arm that writes a
 * run row. Never throws: finalize must not break on bus errors.
 */

import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";

export async function emitFinalizeControlState(
  sessionId: string,
  runId: string,
): Promise<void> {
  try {
    const { controlStateBus, CONTROL_STATE_EVENT_TYPE } = await import(
      "../../../runtime/control-bus.js"
    );
    const { getLease } = await import(
      "../../../../db/repos/runner-leases.js"
    );
    const run = await missionRunsRepo.getRun(runId);
    const lease = await getLease(sessionId);
    if (run === null) return;
    controlStateBus.emit({
      type: CONTROL_STATE_EVENT_TYPE,
      sessionId,
      missionRunId: runId,
      runStatus: run.status,
      stopReason: run.stopReason ?? null,
      pendingControlKind: null,
      leaseActive: lease !== null && lease.expiresAt >= new Date(),
      leaseExpiresAt:
        lease !== null && lease.expiresAt >= new Date()
          ? lease.expiresAt.toISOString()
          : null,
      correlationId: null,
    });
  } catch {
    // intentionally swallowed - finalize must not break on bus errors
  }
}
