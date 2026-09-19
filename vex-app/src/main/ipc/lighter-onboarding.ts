/**
 * Lighter onboarding checklist - `vex:lighterTrading:getOnboardingChecklist`.
 *
 * The ticket's Not connected gate asks where this session's wallet stands on
 * the three onboarding steps. Main answers from address-only reads; nothing
 * here prepares, signs or sends.
 */

import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  lighterAccountSetupStatusInputSchema,
  lighterAccountSetupStatusSchema,
  lighterOnboardingChecklistInputSchema,
  lighterOnboardingChecklistSchema,
  type LighterAccountSetupStatus,
  type LighterOnboardingChecklist,
} from "@shared/schemas/lighter-trading.js";
import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { resolveLighterAccountSetupStatus, resolveLighterOnboardingChecklist } from "../lighter/onboarding-checklist.js";
import { registerHandler } from "./register-handler.js";

/** Both reads share the same provider-unavailable shape; only the copy differs. */
function unavailable(message: string, correlationId: string): Result<never> {
  return err({
    code: "provider.unavailable",
    domain: "market",
    message,
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  });
}

export function registerLighterOnboardingHandlers(): ReadonlyArray<() => void> {
  return [
    registerHandler({
      channel: CH.lighterTrading.getOnboardingChecklist,
      domain: "market",
      inputSchema: lighterOnboardingChecklistInputSchema,
      outputSchema: lighterOnboardingChecklistSchema,
      handle: async (input, ctx): Promise<Result<LighterOnboardingChecklist>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          return ok(await resolveLighterOnboardingChecklist(input));
        } catch (cause) {
          log.warn("[lighter-onboarding] checklist read failed", {
            environment: input.environment,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
          return unavailable("Lighter setup status is temporarily unavailable.", ctx.requestId);
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.getAccountSetupStatus,
      domain: "market",
      inputSchema: lighterAccountSetupStatusInputSchema,
      outputSchema: lighterAccountSetupStatusSchema,
      handle: async (input, ctx): Promise<Result<LighterAccountSetupStatus>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          return ok(await resolveLighterAccountSetupStatus(input));
        } catch (cause) {
          log.warn("[lighter-onboarding] setup status read failed", {
            environment: input.environment,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
          return unavailable("Lighter account setup status is temporarily unavailable.", ctx.requestId);
        }
      },
    }),
  ];
}
