/**
 * `mission.getDiff` — read-only contract status (current hash +
 * accepted hash + isDirty/isAccepted booleans).
 *
 * Phase 6: structured field-by-field diff is intentionally out of
 * scope; the renderer's MissionContractCard uses
 * `mission.getDraft` (full DTO) + this status to gate the Accept
 * button.
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionGetDiffInputSchema,
  missionGetDiffResultSchema,
  type MissionGetDiffResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../../database/engine-db-readiness.js";

export function registerMissionGetDiffHandler(): () => void {
  return registerHandler({
    channel: CH.mission.getDiff,
    domain: "mission",
    inputSchema: missionGetDiffInputSchema,
    outputSchema: missionGetDiffResultSchema,
    handle: async (input, ctx): Promise<Result<MissionGetDiffResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { getContractStatus } = await import(
          "@vex-agent/engine/mission/diff.js"
        );
        const outcome = await getContractStatus({
          sessionId: input.sessionId,
          missionId: input.missionId,
        });
        log.info(
          `[ipc:vex:mission:getDiff] outcome=${outcome.outcome} ` +
            `missionId=${input.missionId} correlationId=${ctx.requestId}`,
        );
        return ok(outcome);
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:getDiff] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
