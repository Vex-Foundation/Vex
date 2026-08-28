import { randomUUID } from "node:crypto";

import { getLighterClient } from "@tools/lighter/client.js";
import { LIGHTER_ENDPOINT_PATHS } from "@tools/lighter/constants.js";
import {
  buildLighterOcoPreview,
  buildLighterUnsignedOcoRequest,
  type LighterOcoPreview,
} from "@tools/lighter/oco-order.js";
import {
  defaultLighterTradingVaultCredentialId,
  evaluateLighterTradingCredentialReadiness,
} from "@tools/lighter/trading-credentials.js";
import * as ocoIntentsRepo from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import * as previewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import { withSessionControlLock } from "@vex-agent/engine/runtime/lease-and-status/session-control-lock.js";
import type { ApprovalPreviewScalar, PreparedActionFollowUp } from "../../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import type { ProtocolHandler } from "../../types.js";
import {
  assertLighterOcoApprovalBinding,
  buildLighterOcoApprovalDisclosure,
  lighterOcoCriticalArgs,
} from "../oco-approval.js";
import { buildLighterOcoExecutionPlan } from "../oco-execution-plan.js";
import {
  executeApprovedLighterOco,
  getConfiguredLighterOcoExecutionDeps,
  type ExecuteApprovedLighterOcoResult,
} from "../oco-order-execution.js";
import { readEnvironment, readLighterOcoProtectionParams } from "../params.js";
import {
  failureDetail,
  findMarketDetail,
  liveProvenance,
  resolvePreviewAccountIndex,
  resolvePreviewApiKeyIndex,
  resolvePreviewMarketId,
} from "./read.js";

function followUp(
  intent: LighterOcoExecutionIntentRow,
  stopLoss: Parameters<typeof buildLighterOcoApprovalDisclosure>[1],
  takeProfit: Parameters<typeof buildLighterOcoApprovalDisclosure>[2],
): PreparedActionFollowUp {
  const disclosure = buildLighterOcoApprovalDisclosure(intent, stopLoss, takeProfit);
  const criticalArgs = lighterOcoCriticalArgs(intent, disclosure) as Record<string, ApprovalPreviewScalar>;
  return {
    toolName: "execute_tool",
    args: { toolId: "lighter.order.create", params: { intentId: intent.intentId } },
    expiresAt: intent.expiresAt,
    approvalPreview: { toolName: "order.create", namespace: "lighter", criticalArgs },
  };
}

async function prepareOco(
  preview: LighterOcoPreview,
  liveSourceJson: Record<string, unknown>,
): Promise<{ readonly intent: LighterOcoExecutionIntentRow; readonly preparedActionFollowUp: PreparedActionFollowUp }> {
  if (preview.preview.apiKeyIndex === null) {
    throw new Error("Managed Lighter trading access is not ready for OCO approval.");
  }
  const readiness = evaluateLighterTradingCredentialReadiness({
    environment: preview.preview.environment,
    accountIndex: preview.preview.accountIndex,
    apiKeyIndex: preview.preview.apiKeyIndex,
    vaultCredentialId: defaultLighterTradingVaultCredentialId({
      environment: preview.preview.environment,
      accountIndex: preview.preview.accountIndex,
      apiKeyIndex: preview.preview.apiKeyIndex,
    }),
  });
  if (!readiness.ready) {
    throw new Error("Managed Lighter trading access is not ready. Continue secure onboarding first.");
  }
  const existing = await ocoIntentsRepo.findLiveByMatch(
    preview.identity.sessionId,
    preview.matchHash,
  );
  let intent = existing;
  if (intent === null) {
    intent = await withSessionControlLock(preview.identity.sessionId, (client) =>
      ocoIntentsRepo.createApprovalPendingWith(client, {
        intentId: `lighter-oco-${randomUUID()}`,
        preview,
        liveSourceJson,
        credentialReadiness: readiness,
        expiresAt: preview.expiresAt,
      }),
    );
  }
  if (
    intent === null
    || intent.approvalStatus !== "approval_pending"
    || intent.executionState !== "approval_pending"
    || Date.parse(intent.expiresAt) <= Date.now()
  ) {
    throw new Error("This OCO preview already has a non-pending execution intent. Run a fresh preview.");
  }
  const [stopLoss, takeProfit] = await Promise.all([
    previewsRepo.findFreshById(intent.sessionId, intent.environment, intent.stopLossPreviewId),
    previewsRepo.findFreshById(intent.sessionId, intent.environment, intent.takeProfitPreviewId),
  ]);
  if (stopLoss === null || takeProfit === null) {
    throw new Error("The exact OCO child previews are no longer fresh.");
  }
  return { intent, preparedActionFollowUp: followUp(intent, stopLoss, takeProfit) };
}

function executionGuidance(result: ExecuteApprovedLighterOcoResult): string {
  if (result.status === "active") {
    return "Both exact reduce-only OCO child orders are proven active on Lighter. Report the stop-loss and take-profit protection as active, and explain that Lighter cancels the sibling when one executes.";
  }
  if (result.status === "resolved") {
    return "Authenticated Lighter evidence proves one OCO child executed and the sibling ended. Report the resolved protection outcome from the returned evidence.";
  }
  if (result.status === "rejected") {
    return "Authenticated Lighter evidence proves both OCO children ended without active protection. Tell the user the position is not protected by this OCO group.";
  }
  if (result.status === "sequencer_pending") {
    return "Lighter accepted the native OCO transaction, but both exact children are not yet proven. Do not call the position protected; check lighter.order.status before any retry.";
  }
  return "The OCO submission outcome is uncertain. Do not claim protection, success, or failure and never retry it automatically; reconcile with lighter.order.status.";
}

export async function executePreparedLighterOco(
  intent: LighterOcoExecutionIntentRow,
  approvalId: string,
) {
  const [stopLoss, takeProfit] = await Promise.all([
    previewsRepo.findById(intent.sessionId, intent.environment, intent.stopLossPreviewId),
    previewsRepo.findById(intent.sessionId, intent.environment, intent.takeProfitPreviewId),
  ]);
  if (stopLoss === null || takeProfit === null) return fail("The exact persisted OCO previews are unavailable.");
  try {
    await assertLighterOcoApprovalBinding({
      approvalId,
      sessionId: intent.sessionId,
      intent,
      stopLossPreview: stopLoss,
      takeProfitPreview: takeProfit,
    });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
  if (Date.parse(intent.expiresAt) <= Date.now()) {
    await ocoIntentsRepo.markApprovalDecision({
      intentId: intent.intentId,
      decision: "expired",
      approvalId,
      reason: "approval resume observed an expired Lighter OCO intent",
    });
    return fail("The Lighter OCO intent expired before approval resume.");
  }
  const approved = await ocoIntentsRepo.markApprovalDecision({
    intentId: intent.intentId,
    decision: "approved",
    approvalId,
    reason: "user approved exact native Lighter OCO protection",
  });
  if (approved === null) return fail("The Lighter OCO intent already left approval_pending.");
  const deps = getConfiguredLighterOcoExecutionDeps();
  if (deps === null) return fail("Lighter native OCO execution is unavailable. No grouped order was signed or submitted.");
  try {
    const plan = buildLighterOcoExecutionPlan(approved);
    const result = await executeApprovedLighterOco({
      plan,
      group: buildLighterUnsignedOcoRequest(plan),
      deps,
    });
    return ok({ source: "vex_lighter_native_oco", ...result, userGuidance: executionGuidance(result) });
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

export const LIGHTER_OCO_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.position.protect": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter OCO protection requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const parsed = readLighterOcoProtectionParams(params);
    if (!parsed.ok) return fail(parsed.reason);
    try {
      const client = getLighterClient();
      const accountIndex = resolvePreviewAccountIndex(environment.value, parsed.value.accountIndex);
      const [marketId, apiKey] = await Promise.all([
        resolvePreviewMarketId(client, environment.value, {
          marketId: parsed.value.marketId,
          marketSymbol: parsed.value.marketSymbol,
          marketType: "perp",
        }),
        resolvePreviewApiKeyIndex(client, environment.value, accountIndex, parsed.value.apiKeyIndex),
      ]);
      const [details, orderBook, account] = await Promise.all([
        client.getMarketDetails(environment.value, { marketId, filter: "perp" }),
        client.getOrderBookOrders(environment.value, { marketId, limit: 10 }),
        client.getAccount(environment.value, { by: "index", value: accountIndex, activeOnly: true }),
      ]);
      const market = findMarketDetail(details, marketId);
      if (market === null || market.market_type !== "perp") {
        return fail("The selected Lighter market is not an active perpetual market.");
      }
      const source = liveProvenance(environment.value, "lighter.position.protect", [
        LIGHTER_ENDPOINT_PATHS.orderBooks,
        LIGHTER_ENDPOINT_PATHS.orderBookDetails,
        LIGHTER_ENDPOINT_PATHS.orderBookOrders,
        LIGHTER_ENDPOINT_PATHS.account,
      ], { marketId, accountIndex, apiKeyIndex: apiKey.apiKeyIndex, groupedOrderType: "oco" });
      const preview = buildLighterOcoPreview({
        sessionId,
        environment: environment.value,
        accountIndex,
        apiKeyIndex: apiKey.apiKeyIndex,
        marketId,
        side: parsed.value.side,
        baseAmount: parsed.value.baseAmount,
        stopLoss: { triggerPrice: parsed.value.stopLossTriggerPrice, price: parsed.value.stopLossPrice },
        takeProfit: { triggerPrice: parsed.value.takeProfitTriggerPrice, price: parsed.value.takeProfitPrice },
        orderExpiry: parsed.value.orderExpiry,
      }, { market, orderBook, account });
      await Promise.all([
        previewsRepo.create({ preview: preview.stopLoss, liveSourceJson: source.provenance as Record<string, unknown> }),
        previewsRepo.create({ preview: preview.takeProfit, liveSourceJson: source.provenance as Record<string, unknown> }),
      ]);
      const prepared = apiKey.apiKeyIndex === null
        ? null
        : await prepareOco(preview, source.provenance as Record<string, unknown>);
      const result = ok({
        ...source,
        status: "oco_preview_ready",
        previewId: preview.previewId,
        matchHash: preview.matchHash,
        expiresAt: preview.expiresAt,
        preview: preview.preview,
        approvalReady: prepared !== null,
        userGuidance: prepared === null
          ? "This is a read-only native OCO preview. Managed Lighter trading setup must finish before approval. No order was signed or submitted."
          : "The exact native Lighter OCO protection is in the approval card. Tell the user to review both trigger prices, both hard execution bounds, side, size, and expiry. No order has been signed or submitted yet.",
        safety: "Vex will submit exactly two same-size reduce-only children in one native Lighter OCO transaction only after explicit approval. It will not emulate sibling cancellation or retry an uncertain submission.",
      });
      return prepared === null ? result : { ...result, preparedActionFollowUp: prepared.preparedActionFollowUp };
    } catch (error) {
      return fail(`Lighter OCO protection preview unavailable (${failureDetail("lighter.position.protect", error)})`);
    }
  },
};
