/**
 * `mission.setAutoRetry` — host-only auto-retry opt-in toggle
 * (phase 4d-5). Persists `constraints_json.autoRetryEnabled` for a
 * draft/ready mission so the autonomous auto-retry path (phase 4d-4)
 * picks it up from the frozen run snapshot at start.
 *
 * Authority is server-side: the engine refuses non-full sessions
 * (`blocked_permission`) and any mission past the editable window
 * (`blocked_status`); a cross-session / missing id collapses to
 * `not_found`. NEVER starts a run.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionSetAutoRetryInputSchema,
  missionSetAutoRetryResultSchema,
  type MissionSetAutoRetryResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";

export function registerMissionSetAutoRetryHandler(): () => void {
  return registerHandler({
    channel: CH.mission.setAutoRetry,
    domain: "mission",
    inputSchema: missionSetAutoRetryInputSchema,
    outputSchema: missionSetAutoRetryResultSchema,
    handle: async (input, ctx): Promise<Result<MissionSetAutoRetryResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { setMissionAutoRetry } = await import(
          "@vex-agent/engine/mission/set-auto-retry.js"
        );
        const outcome = await setMissionAutoRetry({
          sessionId: input.sessionId,
          missionId: input.missionId,
          enabled: input.enabled,
        });
        log.info(
          `[ipc:vex:mission:setAutoRetry] outcome=${outcome.outcome} ` +
            `enabled=${input.enabled} missionId=${input.missionId} ` +
            `correlationId=${ctx.requestId}`,
        );
        return ok(outcome);
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:setAutoRetry] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
