/**
 * `mission.setModel` - the host writer for the mission contract's model
 * (F06), set on the contract card before acceptance. The only writer: the
 * agent's draft tool cannot set it.
 *
 * Authority is server-side: a model is checked against the ACTIVE backend's
 * catalogue here (the same check `chat.submit` applies to a session pick),
 * the engine refuses a mission past the editable draft/ready window
 * (`blocked_status`), collapses a cross-session or missing id to
 * `not_found`, and clears acceptance because the model is contract-hash
 * material (v10). NEVER starts a run.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionSetModelInputSchema,
  missionSetModelResultSchema,
  type MissionSetModelResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { checkModelPick } from "../chat/model-pick.js";

export function registerMissionSetModelHandler(): () => void {
  return registerHandler({
    channel: CH.mission.setModel,
    domain: "mission",
    inputSchema: missionSetModelInputSchema,
    outputSchema: missionSetModelResultSchema,
    handle: async (input, ctx): Promise<Result<MissionSetModelResult>> => {
      if (input.model !== null) {
        const refused = await checkModelPick(input.model, ctx.requestId, ctx.signal);
        if (refused !== null) return err({ ...refused, domain: "mission" });
      }
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { setMissionModel } = await import("@vex-agent/engine/mission/set-model.js");
        const outcome = await setMissionModel({
          sessionId: input.sessionId,
          missionId: input.missionId,
          model: input.model,
        });
        log.info(
          `[ipc:vex:mission:setModel] outcome=${outcome.outcome} ` +
            `missionId=${input.missionId} correlationId=${ctx.requestId}`,
        );
        return ok(outcome);
      } catch (cause) {
        log.warn(`[ipc:vex:mission:setModel] failed correlationId=${ctx.requestId}`, cause);
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
