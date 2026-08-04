/**
 * Failed mission recovery — non-IPC entry. Composes prepare + run
 * halves so tests and direct engine callers keep the same surface.
 *
 * The IPC layer (`vex-app/src/main/ipc/mission/recover.ts`) calls
 * `prepareMissionRecover` directly so it can return `dispatched`
 * synchronously after the durable run row exists.
 *
 * A failed run is immutable audit history. Recovery creates a new
 * run from the failed run's frozen contract snapshot and links it
 * through `recovered_from_run_id`.
 */

import type { TurnResult } from "../../types.js";

import {
  prepareMissionRecover,
  type PrepareMissionRecoverOutcome,
} from "./recover-prepare.js";
import { runPreparedMissionRecover } from "./recover-run.js";

// Re-export the prepare + run halves so the IPC layer can lazy-import
// from this canonical module path.
export {
  prepareMissionRecover,
  type PrepareMissionRecoverOutcome,
  type PreparedMissionRecover,
  type PrepareMissionRecoverInput,
} from "./recover-prepare.js";
export { runPreparedMissionRecover } from "./recover-run.js";

export async function recoverFailedMissionRun(
  sessionId: string,
): Promise<TurnResult> {
  const outcome: PrepareMissionRecoverOutcome = await prepareMissionRecover({
    sessionId,
  });
  switch (outcome.outcome) {
    case "prepared":
      return runPreparedMissionRecover(outcome.prepared);
    case "no_failed_run":
      throw new Error("No failed mission run found for this session.");
    case "session_has_active_run":
      throw new Error(
        `Mission run ${outcome.missionRunId} is still active (${outcome.runStatus}); stop or finish it before recovery.`,
      );
    case "session_not_found":
      throw new Error(`Session ${sessionId} not found`);
    case "lease_busy":
      throw new Error(
        `Session ${sessionId} runner lease busy — another runner is active.`,
      );
    case "session_stop_pending":
      // The operator's Stop reached the session first. It was applied and
      // consumed by the same transaction, so a retry recovers cleanly.
      throw new Error(
        "Recovery did not start: an operator Stop for this session landed first. Try again.",
      );
    case "provider_unavailable":
      throw new Error("No inference provider available");
  }
}
