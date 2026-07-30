/**
 * `mission.recover` — prepare + fire-and-forget recovery of the
 * latest failed run.
 *
 * Same dispatch shape as `mission.start`: `prepareMissionRecover`
 * commits a durable `mission_runs` row (status `running`,
 * `recovered_from_run_id` set) synchronously; `dispatched` only
 * returns after the durable row exists.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionRecoverInputSchema,
  missionRecoverResultSchema,
  type MissionRecoverResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";
import { dispatchPreparedMission } from "./_engine-dispatch.js";

export function registerMissionRecoverHandler(): () => void {
  return registerHandler({
    channel: CH.mission.recover,
    domain: "mission",
    inputSchema: missionRecoverInputSchema,
    outputSchema: missionRecoverResultSchema,
    handle: async (input, ctx): Promise<Result<MissionRecoverResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { prepareMissionRecover, runPreparedMissionRecover } =
          await import("@vex-agent/engine/core/runner/recover.js");
        const prepared = await prepareMissionRecover({
          sessionId: input.sessionId,
        });
        log.info(
          `[ipc:vex:mission:recover] prepare outcome=${prepared.outcome} ` +
            `correlationId=${ctx.requestId}`,
        );
        if (prepared.outcome !== "prepared") {
          return ok(mapRejection(prepared));
        }
        const { newRunId, recoveredFromRunId, missionId, sessionId } =
          prepared.prepared;
        dispatchPreparedMission(
          () => runPreparedMissionRecover(prepared.prepared),
          {
            sessionId,
            missionId,
            missionRunId: newRunId,
            correlationId: ctx.requestId,
            channelLabel: "vex:mission:recover",
            scope: "mission",
          },
        );
        await emitControlStateAfterChange(sessionId, ctx.requestId);
        return ok({
          outcome: "dispatched",
          missionRunId: newRunId,
          recoveredFromRunId,
        });
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:recover] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}

type EnginePrepareRecoverOutcome =
  Awaited<
    ReturnType<
      typeof import("@vex-agent/engine/core/runner/recover.js")["prepareMissionRecover"]
    >
  >;

type EnginePrepareRecoverRejection = Exclude<
  EnginePrepareRecoverOutcome,
  { outcome: "prepared" }
>;

function mapRejection(
  outcome: EnginePrepareRecoverRejection,
): MissionRecoverResult {
  switch (outcome.outcome) {
    case "no_failed_run":
      return { outcome: "no_failed_run" };
    case "session_has_active_run":
      return {
        outcome: "session_has_active_run",
        missionRunId: outcome.missionRunId,
        runStatus: outcome.runStatus,
      };
    case "session_not_found":
      return { outcome: "session_not_found" };
    case "lease_busy": {
      const retryAfterMs = Math.max(
        0,
        outcome.currentLease.expiresAt.getTime() - Date.now(),
      );
      return { outcome: "lease_busy", retryAfterMs };
    }
    case "provider_unavailable":
      return { outcome: "provider_unavailable" };
  }
}
