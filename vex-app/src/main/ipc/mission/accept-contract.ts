/**
 * `mission.acceptContract` — host-only acceptance write.
 *
 * Delegates to `engine/mission/acceptance.ts:acceptContract`, mapping
 * the engine `AcceptContractOutcome` 1:1 to the IPC discriminated
 * union (`missionAcceptContractResultSchema`).
 */

import { CH } from "@shared/ipc/channels.js";
import { ok, err, type Result } from "@shared/ipc/result.js";
import {
  missionAcceptContractInputSchema,
  missionAcceptContractResultSchema,
  type MissionAcceptContractResult,
} from "@shared/schemas/mission.js";
import { log } from "../../logger/index.js";
import { registerHandler } from "../register-handler.js";
import { controlFailedError } from "../runtime/_errors.js";
import { ensureEngineDbUrl } from "../runtime/_ensure-engine-db-url.js";
import { refreshHyperliquidPolicyOverlays } from "../../hyperliquid/policy-provider.js";

export function registerMissionAcceptContractHandler(): () => void {
  return registerHandler({
    channel: CH.mission.acceptContract,
    domain: "mission",
    inputSchema: missionAcceptContractInputSchema,
    outputSchema: missionAcceptContractResultSchema,
    handle: async (input, ctx): Promise<Result<MissionAcceptContractResult>> => {
      const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
      if (!dbUrlOutcome.ok) return dbUrlOutcome;
      try {
        const { acceptContract } = await import(
          "@vex-agent/engine/mission/acceptance.js"
        );
        const outcome = await acceptContract({
          sessionId: input.sessionId,
          missionId: input.missionId,
          contractHash: input.contractHash,
          // Forwarded only when present (plan-mode). The engine's reviewed-plan
          // guard requires it when an enabled, non-empty, unaccepted plan
          // exists; omitted entirely for the plan-mode-OFF default.
          ...(input.planUpdatedAt !== undefined
            ? { planUpdatedAt: input.planUpdatedAt }
            : {}),
        });
        if (outcome.outcome === "accepted") {
          await refreshHyperliquidPolicyOverlays();
        }
        log.info(
          `[ipc:vex:mission:acceptContract] outcome=${outcome.outcome} ` +
            `missionId=${input.missionId} correlationId=${ctx.requestId}`,
        );
        return ok(outcome);
      } catch (cause) {
        log.warn(
          `[ipc:vex:mission:acceptContract] failed correlationId=${ctx.requestId}`,
          cause,
        );
        return err(controlFailedError(ctx.requestId));
      }
    },
  });
}
