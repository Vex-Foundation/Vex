/** `mission.updateDraft` remains fail-closed until the general editor ships. */

import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  missionUpdateDraftInputSchema,
  missionUpdateDraftResultSchema,
  type MissionUpdateDraftResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";

/** Keep the renderer command present but unavailable. Mission changes continue
 * through the engine-owned setup path until a general host editor is designed. */
export function registerMissionUpdateDraftHandler(): () => void {
  return registerHandler({
    channel: CH.mission.updateDraft,
    domain: "mission",
    inputSchema: missionUpdateDraftInputSchema,
    outputSchema: missionUpdateDraftResultSchema,
    handle: async (_input, ctx): Promise<Result<MissionUpdateDraftResult>> => {
      log.info(`[ipc:vex:mission:updateDraft] unavailable correlationId=${ctx.requestId}`);
      return ok({ outcome: "unavailable" });
    },
  });
}
