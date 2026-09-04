/**
 * `mission.start` — atomic prepare + fire-and-forget run.
 *
 * The IPC handler calls `prepareMissionStart({sessionId, missionId})`
 * which synchronously claims the lease + commits the atomic gate +
 * creates the durable `mission_runs` row. `dispatched` is only
 * returned after the durable row exists (codex puzzle-04 phase-6
 * blocker #2/#3: "no dispatched until durable run/request"). The
 * background continuation runs the turn loop and emits a bug report
 * on failure.
 *
 * Cross-session: hostile renderers passing a mismatched `sessionId`
 * are rejected with `session_mismatch` BEFORE any side-effect (codex
 * blocker #1).
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionStartInputSchema,
  missionStartResultSchema,
  type MissionStartResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";
import { dispatchPreparedMission } from "./_engine-dispatch.js";

export function registerMissionStartHandler(): () => void {
  return registerHandler({
    channel: CH.mission.start,
    domain: "mission",
    inputSchema: missionStartInputSchema,
    outputSchema: missionStartResultSchema,
    handle: async (input, ctx): Promise<Result<MissionStartResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { prepareMissionStart, runPreparedMissionStart } = await import(
          "@vex-agent/engine/core/runner/mission.js"
        );
        const prepared = await prepareMissionStart({
          missionId: input.missionId,
          sessionId: input.sessionId,
        });
        log.info(
          `[ipc:vex:mission:start] prepare outcome=${prepared.outcome} ` +
            `missionId=${input.missionId} correlationId=${ctx.requestId}`,
        );
        if (prepared.outcome !== "prepared") {
          return ok(mapRejection(prepared));
        }
        const { runId, missionId, sessionId } = prepared.prepared;
        // Background — the engine helper handles lease release +
        // finalizeMissionRunError on internal throws.
        dispatchPreparedMission(
          () => runPreparedMissionStart(prepared.prepared),
          {
            sessionId,
            missionId,
            missionRunId: runId,
            correlationId: ctx.requestId,
            channelLabel: "vex:mission:start",
            scope: "mission",
          },
        );
        await emitControlStateAfterChange(sessionId, ctx.requestId);
        return ok({ outcome: "dispatched", missionRunId: runId, sessionId });
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:start] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}

type EnginePrepareStartOutcome =
  Awaited<
    ReturnType<
      typeof import("@vex-agent/engine/core/runner/mission.js")["prepareMissionStart"]
    >
  >;

type EnginePrepareStartRejection =
  Exclude<EnginePrepareStartOutcome, { outcome: "prepared" }>;

function mapRejection(
  outcome: EnginePrepareStartRejection,
): MissionStartResult {
  switch (outcome.outcome) {
    case "mission_not_found":
      return { outcome: "mission_not_found" };
    case "session_mismatch":
      return {
        outcome: "session_mismatch",
        expectedSessionId: outcome.expectedSessionId,
      };
    case "session_has_active_run":
      return {
        outcome: "session_has_active_run",
        missionRunId: outcome.missionRunId,
        runStatus: outcome.runStatus,
      };
    case "session_not_found":
      return { outcome: "session_not_found" };
    case "not_accepted":
      return { outcome: "not_accepted", missionId: outcome.missionId };
    case "stale_acceptance":
      return {
        outcome: "stale_acceptance",
        currentHash: outcome.currentHash,
        acceptedHash: outcome.acceptedHash,
      };
    case "plan_not_accepted":
      return { outcome: "plan_not_accepted", missionId: outcome.missionId };
    case "not_ready":
      return {
        outcome: "not_ready",
        missingFields: outcome.missingFields,
      };
    case "active_run_exists":
      return {
        outcome: "active_run_exists",
        missionRunId: outcome.missionRunId,
        runStatus: outcome.runStatus,
      };
    case "lease_busy": {
      const retryAfterMs = Math.max(
        0,
        outcome.currentLease.expiresAt.getTime() - Date.now(),
      );
      return { outcome: "lease_busy", retryAfterMs };
    }
    case "provider_unavailable":
      return { outcome: "provider_unavailable" };
    case "session_stop_pending":
      // The operator's Stop landed first and was consumed by the same
      // transaction, so nothing is parked — a retry starts normally.
      return { outcome: "session_stop_pending" };
  }
}
