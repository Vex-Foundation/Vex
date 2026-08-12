import { randomUUID } from "node:crypto";

import {
  defaultLighterTradingVaultCredentialId,
  evaluateLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";
import * as lighterOrderExecutionIntentsRepo from "@vex-agent/db/repos/lighter-order-execution-intents.js";
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
        "Lighter order create preparation requires a preview bound to a trading API key index from 2 to 254.",
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
      return fail(
        `Lighter preview ${preview.previewId} already has a live order execution intent (${existing.intentId}).`,
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

    const criticalArgs = scalarApprovalPreview({
      toolId: "lighter.order.create",
      intentId: created.intentId,
      environment: created.environment,
      accountIndex: created.accountIndex,
      apiKeyIndex: created.apiKeyIndex,
      marketIndex: created.marketIndex,
      side: created.side,
      baseAmountInteger: created.baseAmountInteger,
      priceInteger: created.priceInteger,
      orderType: created.orderType,
      timeInForce: created.timeInForce,
      reduceOnly: created.reduceOnly,
      previewId: created.previewId,
      matchHash: created.matchHash,
    });
    const followUp: PreparedActionFollowUp = {
      toolName: "execute_tool",
      args: {
        toolId: "lighter.order.create",
        params: { intentId: created.intentId },
      },
      expiresAt,
      approvalPreview: {
        toolName: "execute_tool",
        criticalArgs,
      },
    };

    return {
      ...ok({
        source: "vex_lighter_local_execution_intent",
        status: "approval_prepared",
        message: "Lighter order create prepared; Vex will request approval before any signer path can run.",
        intentId: created.intentId,
        previewId: created.previewId,
        matchHash: created.matchHash,
        environment: created.environment,
        accountIndex: created.accountIndex,
        apiKeyIndex: created.apiKeyIndex,
        executionState: created.executionState,
        approvalStatus: created.approvalStatus,
        expiresAt,
      }),
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

    buildLighterOrderReadyForSignerPlan(approved);
    try {
      requireLighterLiveTradingEnabled();
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err));
    }

    return fail(
      "Lighter order create approval was recorded, but live submission is still blocked until the privileged signer adapter is implemented. No order was signed or submitted.",
    );
  },
};
