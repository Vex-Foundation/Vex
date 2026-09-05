/**
 * `mission.renew` — clone a terminal accepted mission into a fresh
 * draft for the same session. Engine helper handles all
 * preconditions (acceptance, terminal status, no active run).
 *
 * NEVER starts a run — phase 4's `startMission` requires acceptance
 * + the user to click Accept on the new draft.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionRenewInputSchema,
  missionRenewResultSchema,
  type MissionRenewResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";
import { emitControlStateAfterChange } from "../runtime/_emit-control-state.js";

export function registerMissionRenewHandler(): () => void {
  return registerHandler({
    channel: CH.mission.renew,
    domain: "mission",
    inputSchema: missionRenewInputSchema,
    outputSchema: missionRenewResultSchema,
    handle: async (input, ctx): Promise<Result<MissionRenewResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { renewMission } = await import(
          "@vex-agent/engine/mission/renew.js"
        );
        const outcome = await renewMission({
          sessionId: input.sessionId,
          previousMissionId: input.previousMissionId,
        });
        log.info(
          `[ipc:vex:mission:renew] outcome=${outcome.outcome} ` +
            `previousMissionId=${input.previousMissionId} ` +
            `correlationId=${ctx.requestId}`,
        );
        if (outcome.outcome === "renewed") {
          // The engine may have promoted the new draft straight to 'ready'
          // (reconcileDraftReadiness, issue #41) — refresh the renderer so
          // the badge reflects it without a remount.
          await emitControlStateAfterChange(input.sessionId, ctx.requestId);
        }
        return ok(outcome);
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:renew] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
