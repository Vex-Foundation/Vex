import { randomUUID } from "node:crypto";

import {
  defaultLighterTradingVaultCredentialId,
  evaluateLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { readEnvironment } from "../params.js";
import {
  buildLighterOrderReadyForSignerPlan,
  requireLighterLiveTradingEnabled,
} from "../execution-plan.js";
import { buildLighterUnsignedCreateOrderRequest } from "@tools/lighter/signer-order.js";
import { isLighterLiveTradingEnabled } from "../execution-boundary.js";
import {
  executeApprovedLighterCreateOrder,
  getConfiguredLighterCreateOrderExecutionDeps,
} from "../order-create-execution.js";
import { assertLighterOrderCreateApprovalBinding } from "../approval-binding.js";
import { buildLighterOrderApprovalDisclosure } from "../approval-disclosure.js";

function readRequiredString(
  params: Record<string, unknown>,
  key: "previewId" | "vaultCredentialId" | "intentId",
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string } {
  const value = params[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { ok: false, reason: `Missing required: ${key}.` };
  }
  return { ok: true, value: value.trim() };
}

function readOptionalString(
  params: Record<string, unknown>,
  key: "previewId" | "vaultCredentialId",
): string | null {
  const value = params[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function executionIntentExpiresAt(previewExpiresAt: string): string {
  const previewMs = Date.parse(previewExpiresAt);
  return new Date(Number.isFinite(previewMs) ? previewMs : Date.now()).toISOString();
}

function scalarApprovalPreview(
  values: Record<string, ApprovalPreviewScalar>,
): Record<string, ApprovalPreviewScalar> {
  return values;
}

function buildCreateApprovalFollowUp(
  intent: LighterOrderExecutionIntentRow,
  preview: Parameters<typeof buildLighterOrderApprovalDisclosure>[1],
): PreparedActionFollowUp {
  const disclosure = buildLighterOrderApprovalDisclosure(intent, preview);
  const criticalArgs = scalarApprovalPreview({
    orderSummary: disclosure.orderSummary,
    marketSymbol: disclosure.marketSymbol,
    baseAmountDisplay: disclosure.baseAmountDisplay,
    priceDisplay: disclosure.priceDisplay,
    notionalDisplay: disclosure.notionalDisplay,
    orderExpiryIso: disclosure.orderExpiryIso,
    toolId: "lighter.order.create",
    intentId: intent.intentId,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    side: intent.side,
    baseAmountInteger: intent.baseAmountInteger,
    priceInteger: intent.priceInteger,
    orderType: intent.orderType,
    timeInForce: intent.timeInForce,
    reduceOnly: intent.reduceOnly,
    previewId: intent.previewId,
    matchHash: intent.matchHash,
  });
  return {
    toolName: "execute_tool",
    args: {
      toolId: "lighter.order.create",
      params: { intentId: intent.intentId },
    },
    expiresAt: intent.expiresAt,
    approvalPreview: {
      toolName: "order.create",
      namespace: "lighter",
      criticalArgs,
    },
  };
}

function approvalPreparedPayload(
  intent: LighterOrderExecutionIntentRow,
  input: {
    readonly status: "approval_prepared" | "approval_prepared_existing";
    readonly message: string;
  },
): Record<string, unknown> {
  return {
    source: "vex_lighter_local_execution_intent",
    status: input.status,
    message: input.message,
    intentId: intent.intentId,
    previewId: intent.previewId,
    matchHash: intent.matchHash,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    executionState: intent.executionState,
    approvalStatus: intent.approvalStatus,
    expiresAt: intent.expiresAt,
    approvalUi: {
      surface: "approval_card",
      approveLabel: "Approve and execute trade",
      rejectLabel: "Reject",
    },
    userGuidance:
      "An approval card is now available in the app. Tell the user to review the card and click Approve and execute trade only if the exact order details are correct; do not ask them to type another approval command.",
  };
}

export const LIGHTER_WRITE_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.order.create.prepare": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter order create preparation requires a host session id.");

    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const previewId = readOptionalString(params, "previewId");
    const preview = previewId
      ? await lighterOrderPreviewsRepo.findFreshById(
          sessionId,
          environment.value,
          previewId,
        )
      : await lighterOrderPreviewsRepo.findLatestFresh(sessionId, environment.value);
    if (!preview) {
      return fail(
        previewId
          ? `No fresh Lighter order preview ${previewId} found for ${environment.value} in this session. Run lighter.order.preview again.`
          : `No fresh Lighter order preview found for ${environment.value} in this session. Run lighter.order.preview first.`,
      );
    }
    if (preview.apiKeyIndex === null) {
      return fail(
        "Lighter order create preparation needs a saved Lighter trading API key for this account. Open Settings > API keys, add the Lighter trading key, then run a fresh preview.",
      );
    }

    const vaultCredentialId =
      readOptionalString(params, "vaultCredentialId")
      ?? defaultLighterTradingVaultCredentialId({
        environment: preview.environment,
        accountIndex: preview.accountIndex,
        apiKeyIndex: preview.apiKeyIndex,
      });
    const readiness = evaluateLighterTradingCredentialReadiness({
      environment: preview.environment,
      accountIndex: preview.accountIndex,
      apiKeyIndex: preview.apiKeyIndex,
      vaultCredentialId,
    });
    if (!readiness.ready) {
      return fail(`Lighter trading credential is not ready: ${readiness.reason}`);
    }

    const existing = await lighterOrderExecutionIntentsRepo.findLiveByPreview(
      sessionId,
      preview.previewId,
    );
    if (existing !== null) {
      if (
        existing.approvalStatus === "approval_pending"
        && existing.executionState === "approval_pending"
        && Date.parse(existing.expiresAt) > Date.now()
      ) {
        let existingFollowUp: PreparedActionFollowUp;
        try {
          existingFollowUp = buildCreateApprovalFollowUp(existing, preview);
        } catch (err) {
          return fail(err instanceof Error ? err.message : String(err));
        }
        return {
          ...ok(approvalPreparedPayload(existing, {
            status: "approval_prepared_existing",
            message:
              "Lighter order create was already prepared; Vex will request approval for the existing pending intent.",
          })),
          preparedActionFollowUp: existingFollowUp,
        };
      }
      return fail(
        `Lighter preview ${preview.previewId} already has a live order execution intent (${existing.intentId}) in state ${existing.executionState}. It cannot be prepared again from the same preview.`,
      );
    }

    const intentId = `lighter-exec-${randomUUID()}`;
    const expiresAt = executionIntentExpiresAt(preview.expiresAt);
    const created = await withSessionControlLock(sessionId, (client) =>
      lighterOrderExecutionIntentsRepo.createApprovalPendingWith(client, {
        intentId,
        preview,
        credentialReadiness: readiness,
        expiresAt,
      }),
    );
    if (created === null) {
      return fail(`Lighter order execution intent ${intentId} already exists. Retry preparation.`);
    }

    let followUp: PreparedActionFollowUp;
    try {
      followUp = buildCreateApprovalFollowUp(created, preview);
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    return {
      ...ok(approvalPreparedPayload(created, {
        status: "approval_prepared",
        message: "Lighter order create prepared; Vex will request approval before any signer path can run.",
      })),
      preparedActionFollowUp: followUp,
    };
  },

  "lighter.order.create": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter order create requires a host session id.");
    const intentId = readRequiredString(params, "intentId");
    if (!intentId.ok) return fail(intentId.reason);
    if (!context.approved || !context.approvalId) {
      return fail(
        "Lighter order create requires an approved Vex approval card for a prepared execution intent.",
      );
    }

    const intent = await lighterOrderExecutionIntentsRepo.findByIntentId(sessionId, intentId.value);
    if (!intent) {
      return fail(`No Lighter order execution intent ${intentId.value} found in this session.`);
    }
    try {
      await assertLighterOrderCreateApprovalBinding({
        approvalId: context.approvalId,
        sessionId,
        intent,
      });
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }
    if (Date.parse(intent.expiresAt) <= Date.now()) {
      await lighterOrderExecutionIntentsRepo.markApprovalDecision({
        intentId: intent.intentId,
        decision: "expired",
        approvalId: context.approvalId,
        reason: "approval resume observed an expired Lighter execution intent",
      });
      return fail(`Lighter order execution intent ${intent.intentId} expired before approval resume.`);
    }

    const approved = await lighterOrderExecutionIntentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "approved",
      approvalId: context.approvalId,
      reason: "user approved exact Lighter order create intent",
    });
    if (approved === null) {
      return fail(`Lighter order execution intent ${intent.intentId} has already left approval_pending.`);
    }

    try {
      const plan = buildLighterOrderReadyForSignerPlan(approved);
      const unsignedOrder = buildLighterUnsignedCreateOrderRequest(plan);
      if (isLighterLiveTradingEnabled()) {
        const deps = getConfiguredLighterCreateOrderExecutionDeps();
        if (deps === null) {
          return fail(
            "Lighter live order create is enabled, but the privileged signer and vault dependencies are not configured. No order was signed or submitted.",
          );
        }
        const execution = await executeApprovedLighterCreateOrder({
          plan,
          unsignedOrder,
          deps,
        });
        return ok({
          source: "vex_lighter_live_order_create",
          ...execution,
        });
      }
      requireLighterLiveTradingEnabled();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    return fail(
      "Lighter order create approval was recorded, but live submission is still blocked by the explicit Lighter live-trading release gate. No order was signed or submitted.",
    );
  },
};
