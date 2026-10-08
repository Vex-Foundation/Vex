/**
 * `mission.setReasoningEffort` - the host writer for the mission contract's
 * reasoning effort (Kairos E-1), set on the contract card before acceptance.
 *
 * Authority is server-side: the engine refuses a mission past the editable
 * draft/ready window (`blocked_status`), collapses a cross-session or missing
 * id to `not_found`, and clears acceptance because the effort is contract-hash
 * material (v8). NEVER starts a run.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionSetReasoningEffortInputSchema,
  missionSetReasoningEffortResultSchema,
  type MissionSetReasoningEffortResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";

export function registerMissionSetReasoningEffortHandler(): () => void {
  return registerHandler({
    channel: CH.mission.setReasoningEffort,
    domain: "mission",
    inputSchema: missionSetReasoningEffortInputSchema,
    outputSchema: missionSetReasoningEffortResultSchema,
    handle: async (input, ctx): Promise<Result<MissionSetReasoningEffortResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { setMissionReasoningEffort } = await import(
          "@vex-agent/engine/mission/set-reasoning-effort.js"
        );
        const outcome = await setMissionReasoningEffort({
          sessionId: input.sessionId,
          missionId: input.missionId,
          reasoningEffort: input.reasoningEffort,
        });
        log.info(
          `[ipc:vex:mission:setReasoningEffort] outcome=${outcome.outcome} ` +
            `missionId=${input.missionId} correlationId=${ctx.requestId}`,
        );
        return ok(outcome);
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:setReasoningEffort] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
