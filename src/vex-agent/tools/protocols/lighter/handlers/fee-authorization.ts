import * as intents from "@vex-agent/db/repos/lighter-fee-authorization-intents.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import type { PreparedActionFollowUp } from "../../../types.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { readEnvironment } from "../params.js";
import { getConfiguredLighterFeeAuthorizationService } from "../fee-authorization-execution.js";
import { buildLighterFeeAuthorizationDisclosure } from "../fee-authorization-disclosure.js";
import { assertLighterFeeAuthorizationApprovalBinding } from "../fee-authorization-approval-binding.js";

export function buildLighterFeeAuthorizationApprovalFollowUp(
  intent: intents.LighterFeeAuthorizationIntentRow,
): PreparedActionFollowUp {
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.fees.approve",
      params: { intentId: intent.intentId },
    },
    expiresAt: intent.expiresAt.toISOString(),
    approvalPreview: {
      namespace: "lighter",
      toolName: "fees.approve",
      criticalArgs: buildLighterFeeAuthorizationDisclosure(intent),
    },
  };
}

export const LIGHTER_FEE_AUTHORIZATION_HANDLERS: Record<
  string,
  ProtocolHandler
> = {
  "lighter.fees.approve.prepare": async (params, context) => {
    if (!context.sessionId) return fail("Fee setup requires a VEX session.");
    if (
      Object.keys(params).some(
        (key) => key !== "environment" && key !== "revoke",
      )
    ) {
      return fail(
        "Fee setup accepts only environment and revoke. VEX supplies the recipient and rates.",
      );
    }
    if (params.revoke !== undefined && typeof params.revoke !== "boolean")
      return fail("revoke must be a boolean.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const service = getConfiguredLighterFeeAuthorizationService();
    if (!service)
      return fail(
        "Secure Lighter fee setup is unavailable in this app session.",
      );
    try {
      const input = {
        sessionId: context.sessionId,
        environment: environment.value,
        walletResolution: context.walletResolution,
        walletPolicy: context.walletPolicy,
      };
      if (!params.revoke) {
        const readiness = await service.inspect(input);
        if (readiness.status === "disabled" || readiness.status === "ready")
          return ok(readiness);
        if (readiness.status === "blocked") return fail(readiness.reason);
      }
      const intent = await service.prepare({
        ...input,
        revoke: params.revoke === true,
      });
      if (intent.executionState !== "approval_pending")
        return ok({
          status: "pending_verification",
          intentId: intent.intentId,
          message:
            "An existing fee setup requires reconciliation. Run lighter.fees.status; do not submit another authorization.",
        });
      return {
        ...ok({
          status: "approval_prepared",
          intentId: intent.intentId,
          message:
            "Review the trading fee authorization in VEX. No fee authorization has been submitted.",
          approvalUi: {
            surface: "approval_card",
            approveLabel: intent.terms.revoke
              ? "Revoke trading fees"
              : "Approve trading fees",
            rejectLabel: "Reject",
          },
          userGuidance:
            "Use this prepared host approval. Do not ask for account IDs, keys or a separate chat confirmation. If rejected, stop fee setup until the user requests it again.",
        }),
        preparedActionFollowUp:
          buildLighterFeeAuthorizationApprovalFollowUp(intent),
      };
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message
          : "Fee setup could not be prepared.",
      );
    }
  },
  "lighter.fees.approve": async (params, context) => {
    if (!context.approved || !context.approvalId)
      return {
        success: false,
        pendingApproval: true,
        output: "Fee authorization requires an approved VEX card.",
      };
    if (
      !context.sessionId ||
      typeof params.intentId !== "string" ||
      Object.keys(params).join(",") !== "intentId"
    ) {
      return fail("Fee approval requires the exact session-owned intentId.");
    }
    const service = getConfiguredLighterFeeAuthorizationService();
    if (!service) return fail("Secure Lighter fee execution is unavailable.");
    try {
      const intent = await intents.findLighterFeeAuthorizationIntent(
        params.intentId,
      );
      if (!intent || intent.sessionId !== context.sessionId)
        return fail("Fee authorization does not belong to this session.");
      await assertLighterFeeAuthorizationApprovalBinding({
        intent,
        sessionId: context.sessionId,
        approvalId: context.approvalId,
      });
      const approved =
        intent.executionState === "approval_pending"
          ? await withSessionControlLock(context.sessionId, (client) =>
              intents.markLighterFeeAuthorizationDecisionWith(client, {
                intentId: intent.intentId,
                sessionId: context.sessionId!,
                approvalId: context.approvalId!,
                status: "approved",
              }),
            )
          : intent;
      if (
        !approved ||
        approved.approvalStatus !== "approved" ||
        approved.approvalId !== context.approvalId
      ) {
        return fail(
          "The fee authorization expired or its approval changed. Prepare it again.",
        );
      }
      return ok(
        await service.execute({
          sessionId: context.sessionId,
          intentId: intent.intentId,
          walletResolution: context.walletResolution,
          walletPolicy: context.walletPolicy,
          abortSignal: context.abortSignal,
        }),
      );
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message
          : "Fee authorization could not complete.",
      );
    }
  },
  "lighter.fees.status": async (params, context) => {
    if (!context.sessionId) return fail("Fee status requires a VEX session.");
    const service = getConfiguredLighterFeeAuthorizationService();
    if (!service) return fail("Secure Lighter fee status is unavailable.");
    try {
      if (typeof params.intentId === "string")
        return ok(
          await service.reconcile({
            sessionId: context.sessionId,
            intentId: params.intentId,
            walletResolution: context.walletResolution,
            walletPolicy: context.walletPolicy,
            abortSignal: context.abortSignal,
          }),
        );
      const environment = readEnvironment(params);
      if (!environment.ok) return fail(environment.reason);
      return ok(
        await service.inspect({
          sessionId: context.sessionId,
          environment: environment.value,
          walletResolution: context.walletResolution,
          walletPolicy: context.walletPolicy,
        }),
      );
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message
          : "Fee status could not be verified.",
      );
    }
  },
};
