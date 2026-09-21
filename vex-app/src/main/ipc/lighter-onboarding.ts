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
  lighterKeyRegistrationReconcileInputSchema,
  lighterKeyRegistrationReconcileSchema,
  lighterOnboardingChecklistInputSchema,
  lighterOnboardingChecklistSchema,
  type LighterAccountSetupStatus,
  type LighterKeyRegistrationReconcile,
  type LighterOnboardingChecklist,
} from "@shared/schemas/lighter-trading.js";
import {
  lighterSetupPendingInputSchema,
  lighterSetupPendingSchema,
  lighterSetupSettleInputSchema,
  lighterSetupSettleResultSchema,
  type LighterSetupPending,
  type LighterSetupSettleResult,
} from "@shared/schemas/lighter-setup-handoff.js";
import {
  getById as getLighterSetupInteraction,
  getPendingForSession,
  settleIfPendingWith,
} from "@vex-agent/db/repos/lighter-setup-interactions.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status.js";
import { resumeAgentAfterLighterSetup } from "@vex-agent/engine/core/lighter-setup-resume.js";
import { log } from "../logger/index.js";
import { ensureEngineDbUrl } from "../database/engine-db-readiness.js";
import { resolveLighterAccountSetupStatus, resolveLighterOnboardingChecklist } from "../lighter/onboarding-checklist.js";
import { reconcileSetupKeyRegistration } from "../lighter/key-registration-reconcile.js";
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
    registerHandler({
      channel: CH.lighterTrading.reconcileKeyRegistration,
      domain: "market",
      inputSchema: lighterKeyRegistrationReconcileInputSchema,
      outputSchema: lighterKeyRegistrationReconcileSchema,
      handle: async (input, ctx): Promise<Result<LighterKeyRegistrationReconcile>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        try {
          return ok(await reconcileSetupKeyRegistration(input));
        } catch (cause) {
          // A reconcile that will not answer leaves the registration exactly
          // as it was; the caller polls and asks again.
          log.warn("[lighter-onboarding] key registration reconcile failed", {
            environment: input.environment,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
          return unavailable(
            "Lighter could not confirm the trading key just now.",
            ctx.requestId,
          );
        }
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.getPendingAgentSetup,
      domain: "market",
      inputSchema: lighterSetupPendingInputSchema,
      outputSchema: lighterSetupPendingSchema,
      handle: async (input, ctx): Promise<Result<LighterSetupPending>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;
        const pending = await getPendingForSession(input.sessionId);
        return ok({
          interaction: pending === null ? null : {
            intentId: pending.intentId,
            sessionId: pending.sessionId,
            environment: pending.environment,
            status: "pending",
            createdAt: pending.createdAt,
          },
        });
      },
    }),
    registerHandler({
      channel: CH.lighterTrading.settleAgentSetup,
      domain: "market",
      inputSchema: lighterSetupSettleInputSchema,
      outputSchema: lighterSetupSettleResultSchema,
      handle: async (input, ctx): Promise<Result<LighterSetupSettleResult>> => {
        const dbUrlOutcome = await ensureEngineDbUrl(ctx.requestId);
        if (!dbUrlOutcome.ok) return dbUrlOutcome;

        const current = await getLighterSetupInteraction(input.intentId, input.sessionId);
        if (current === null) {
          return err({
            code: "validation.invalid_input",
            domain: "market",
            message: "This Lighter setup request is no longer available.",
            retryable: false,
            userActionable: true,
            redacted: true,
            correlationId: ctx.requestId,
          });
        }

        if (input.outcome === "completed" && current.status === "pending") {
          const status = await resolveLighterAccountSetupStatus({
            sessionId: input.sessionId,
            environment: current.environment,
          });
          if (!status.accountExists || !status.tradingKeyRegistered || !status.feeAuthorized) {
            return err({
              code: "validation.invalid_input",
              domain: "market",
              message: "Lighter setup is not fully confirmed yet. Check the setup status and try again.",
              retryable: true,
              userActionable: true,
              redacted: true,
              correlationId: ctx.requestId,
            });
          }
        }

        const targetStatus = input.outcome === "completed" ? "completed" : "cancelled";
        const settled = current.status === "pending"
          ? await withSessionControlLock(input.sessionId, (client) =>
              settleIfPendingWith(
                client,
                input.intentId,
                input.sessionId,
                targetStatus,
              ))
          : current.status === targetStatus ? current : null;
        if (settled === null) return ok({ settled: false, resumedAgentTurn: false });

        // Settlement is the acknowledgement the modal is waiting for. The
        // resumed model turn may take seconds (or pause again for approval), so
        // it must not hold the dialog on screen. The continuation is durable
        // and owns its own bounded busy retry; start it after the CAS and let
        // IPC return immediately.
        void resumeAgentAfterLighterSetup({
          intentId: input.intentId,
          sessionId: input.sessionId,
        }).catch((cause: unknown) => {
          log.warn("[lighter-onboarding] setup continuation failed", {
            intentId: input.intentId,
            sessionId: input.sessionId,
            cause: cause instanceof Error ? cause.message : String(cause),
          });
        });
        return ok({
          settled: true,
          resumedAgentTurn: current.resumeConsumedAt !== null,
        });
      },
    }),
  ];
}
