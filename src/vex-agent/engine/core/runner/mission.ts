/**
 * Mission lifecycle entry points — thin composition of the
 * prepare + run split (puzzle 04 phase 6).
 *
 * `startMission(missionId)` and `resumeMissionRun(runId)` exist for
 * non-IPC callers (tests / direct engine consumers) that don't
 * have the sessionId or pre-resolved provider/config in scope. The
 * IPC layer in `vex-app/src/main/ipc/mission/` calls
 * `prepareMissionStart` directly to keep durable dispatch semantics
 * (codex blocker: `dispatched` must not return until a durable
 * `mission_runs` row exists).
 *
 * Permission semantics: post-M12 missions inherit their approval
 * permission from the owning session (`sessions.permission`),
 * hydrated once at session load. Mission runs no longer carry their
 * own `loop_mode` column.
 */

import {
  MissionRunPausedError,
  TERMINAL_RUN_STATUSES,
  type ResumedTurnClaim,
  type TurnResult,
} from "../../types.js";
import { resolveProvider } from "@vex-agent/inference/registry.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import * as missionsRepo from "@vex-agent/db/repos/missions.js";
import logger from "@utils/logger.js";
import { finalizeMissionRunError } from "./mission-finalize.js";

import {
  prepareMissionStart,
  type PrepareMissionStartOutcome,
} from "./mission-prepare.js";
import {
  resumePreparedMissionRun,
  runPreparedMissionStart,
} from "./mission-run.js";

// Re-export the prepare + run halves so the IPC layer can lazy-import
// from this canonical module path.
export {
  prepareMissionStart,
  type PrepareMissionStartOutcome,
  type PreparedMissionStart,
  type PrepareMissionStartInput,
} from "./mission-prepare.js";
export {
  runPreparedMissionStart,
  resumePreparedMissionRun,
  type PreparedResumeRun,
} from "./mission-run.js";

/**
 * Start a mission — non-IPC entry. Composes the prepare + run halves
 * for callers without sessionId in scope. The IPC layer calls
 * `prepareMissionStart` directly so it can return `dispatched`
 * synchronously after the durable `mission_runs` row exists.
 */
export async function startMission(missionId: string): Promise<TurnResult> {
  logger.info("engine.mission.start", { missionId });

  // Non-IPC entry: no host-supplied sessionId — engine derives the
  // canonical session id from the mission row inside
  // `prepareMissionStart`. The IPC layer passes its own sessionId to
  // get the cross-session ownership check.
  const outcome: PrepareMissionStartOutcome = await prepareMissionStart({
    missionId,
  });
  switch (outcome.outcome) {
    case "prepared":
      return runPreparedMissionStart(outcome.prepared);
    case "mission_not_found":
      throw new Error(`Mission ${missionId} not found`);
    case "session_mismatch":
      // Unreachable on the no-sessionId path; kept for type exhaustiveness.
      throw new Error(
        `Mission ${missionId} session mismatch (expected ${outcome.expectedSessionId})`,
      );
    case "session_has_active_run":
      throw new Error(
        `Session has an active mission run: ${outcome.missionRunId} (${outcome.runStatus})`,
      );
    case "session_not_found":
      throw new Error(`Session for mission ${missionId} not found`);
    case "not_accepted":
      throw new Error(
        `Mission ${missionId} has not been accepted — accept the contract before starting.`,
      );
    case "stale_acceptance":
      throw new Error(
        `Mission ${missionId} contract changed since acceptance — re-accept the current contract before starting.`,
      );
    case "plan_not_accepted":
      throw new Error(
        `Mission ${missionId} action plan is not accepted — review and accept the plan before starting.`,
      );
    case "not_ready":
      throw new Error(
        `Mission ${missionId} is not ready — missing required fields: ${outcome.missingFields.join(", ")}`,
      );
    case "active_run_exists":
      throw new Error(
        `Mission ${missionId} already has an active run: ${outcome.missionRunId}`,
      );
    case "lease_busy":
      throw new Error(
        "Session runner lease busy — another runner is active.",
      );
    case "provider_unavailable":
      throw new Error("No inference provider available");
  }
}

/**
 * Resume a mission run after checkpoint or restart. Non-IPC entry —
 * the IPC layer's resume path goes through the shared runtime
 * dispatcher (`request-resume.ts` / `_shared/runtime-resume-dispatch`).
 *
 * `claimTurn` (optional) is the resumed-turn guard: it runs after the
 * fallible pre-resume reads and immediately before the run core, and a
 * `false` return abandons the resume without running it. It only
 * REPORTS whether an earlier attempt already completed this resume —
 * the durable marker is written by the caller after this function
 * returns, so a failure anywhere below leaves the approval recoverable.
 */
export async function resumeMissionRun(
  runId: string,
  /**
   * The lease owner id the CALLER claimed and holds around this call. Required,
   * not optional — every resume entry point (wake executor, auto-retry,
   * approval continuation, ingress preempt, IPC resume/retry) claims a named
   * lease first, and an optional parameter is precisely how that proof used to
   * be dropped, leaving a resumed run unable to consume a prepared compaction.
   */
  runnerOwnerId: string,
  claimTurn?: ResumedTurnClaim,
): Promise<TurnResult> {
  logger.info("engine.mission.resume", { runId });

  // Read run + check terminal status OUTSIDE the finalize-on-error try.
  // A terminal row is immutable audit history — finalizing it would
  // corrupt the durable status (codex puzzle 04 phase 6 review #1).
  const run = await missionRunsRepo.getRun(runId);
  if (!run) throw new Error(`Run ${runId} not found`);
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    throw new Error(`Run ${runId} is terminal (${run.status}) — cannot resume`);
  }

  try {
    const provider = await resolveProvider();
    if (!provider) throw new Error("No inference provider available");
    const config = await provider.loadConfig();
    if (!config) throw new Error("No inference config available");

    const mission = await missionsRepo.getMission(run.missionId);
    if (!mission) throw new Error(`Mission ${run.missionId} not found`);

    // Everything above is fallible pre-resume work; from here the run
    // core actually starts, so this is where a resumed turn checks that
    // it is still the one that should deliver the wake. Everything BELOW
    // is fallible too — which is why nothing durable is written here.
    if (claimTurn !== undefined && !(await claimTurn())) {
      return {
        text: null,
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: null,
        missionStatus: null,
      };
    }

    // Permission read from session is deferred to
    // `resumePreparedMissionRun`'s `hydrateEngineSession` so a missing
    // session row lands in `paused_error` via the protected try/catch
    // rather than throwing here mid-resume.
    return await resumePreparedMissionRun({
      runId,
      runnerOwnerId,
      run,
      mission,
      provider,
      config,
    });
  } catch (err) {
    // Skip double-finalize: `resumePreparedMissionRun` already wraps
    // its internal turn loop in a try/catch that calls
    // `finalizeMissionRunError` and throws `MissionRunPausedError`.
    // Re-finalizing here would emit duplicate bug reports and rewrite
    // the already-set `paused_error` row.
    if (err instanceof MissionRunPausedError) {
      throw err;
    }
    // Pre-resume reads failed (provider/config/mission lookup) AFTER
    // the caller already flipped the run to `running`. Finalize as
    // `paused_error` so the row doesn't stay stranded at `running`.
    try {
      await finalizeMissionRunError(run.missionId, runId, run.sessionId, err);
    } catch (finalizeErr) {
      logger.warn("engine.mission.resume.finalize_failed", {
        runId,
        sessionId: run.sessionId,
        error: finalizeErr instanceof Error
          ? finalizeErr.message
          : String(finalizeErr),
      });
    }
    throw err;
  }
}
