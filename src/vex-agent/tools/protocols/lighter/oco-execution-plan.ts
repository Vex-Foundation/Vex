import type { LighterOcoSignerPlan } from "@tools/lighter/oco-order.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import type { LighterOcoExecutionIntentRow } from "@vex-agent/db/repos/lighter-oco-execution-intents.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import type { LighterOrderReadyForSignerPlan } from "./execution-plan.js";

export interface LighterOcoExecutionPlan extends LighterOcoSignerPlan {
  readonly intentId: string;
  readonly sessionId: string;
  readonly stopLossPreviewId: string;
  readonly takeProfitPreviewId: string;
  readonly clientOrderIndexPolicy: string;
  readonly providerVersion: string;
  readonly credentialReference: LighterTradingCredentialVaultReference;
  readonly nonceScope: {
    readonly environment: LighterOcoExecutionIntentRow["environment"];
    readonly accountIndex: number;
    readonly apiKeyIndex: number;
  };
}

export function buildLighterOcoExecutionPlan(
  intent: LighterOcoExecutionIntentRow,
  nowMs = Date.now(),
): LighterOcoExecutionPlan {
  if (intent.approvalStatus !== "approved" || intent.executionState !== "approval_pending") {
    throw invalidRequest(`Lighter OCO intent ${intent.intentId} is not ready for signing.`);
  }
  if (Date.parse(intent.expiresAt) <= nowMs) {
    throw invalidRequest(`Lighter OCO intent ${intent.intentId} expired before signing.`);
  }
  if (intent.nonceReservationId !== null || intent.nonceValue !== null) {
    throw invalidRequest(`Lighter OCO intent ${intent.intentId} already has a nonce reservation.`);
  }
  const ref = intent.credentialRefJson;
  if (
    ref.kind !== "encrypted_vault_reference"
    || ref.environment !== intent.environment
    || ref.accountIndex !== intent.accountIndex
    || ref.apiKeyIndex !== intent.apiKeyIndex
    || ref.vaultCredentialId.trim().length === 0
  ) {
    throw invalidRequest("Lighter OCO credential reference does not match the approved account scope.");
  }
  return {
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    stopLossPreviewId: intent.stopLossPreviewId,
    takeProfitPreviewId: intent.takeProfitPreviewId,
    matchHash: intent.matchHash,
    environment: intent.environment,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    marketIndex: intent.marketIndex,
    side: intent.side,
    baseAmountInteger: intent.baseAmountInteger,
    orderExpiryMs: intent.orderExpiryMs,
    stopLoss: {
      matchHash: intent.stopLossMatchHash,
      priceInteger: intent.stopLossPriceInteger,
      triggerPriceInteger: intent.stopLossTriggerPriceInteger,
    },
    takeProfit: {
      matchHash: intent.takeProfitMatchHash,
      priceInteger: intent.takeProfitPriceInteger,
      triggerPriceInteger: intent.takeProfitTriggerPriceInteger,
    },
    clientOrderIndexPolicy: intent.clientOrderIndexPolicy,
    providerVersion: intent.providerVersion,
    credentialReference: ref,
    nonceScope: {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    },
  };
}

export function ocoLegRevalidationPlan(
  plan: LighterOcoExecutionPlan,
  kind: "stop-loss" | "take-profit",
): LighterOrderReadyForSignerPlan {
  const leg = kind === "stop-loss" ? plan.stopLoss : plan.takeProfit;
  return {
    intentId: plan.intentId,
    sessionId: plan.sessionId,
    previewId: kind === "stop-loss" ? plan.stopLossPreviewId : plan.takeProfitPreviewId,
    matchHash: leg.matchHash,
    environment: plan.environment,
    accountIndex: plan.accountIndex,
    apiKeyIndex: plan.apiKeyIndex,
    marketIndex: plan.marketIndex,
    side: plan.side,
    baseAmountInteger: plan.baseAmountInteger,
    priceInteger: leg.priceInteger,
    orderType: kind,
    timeInForce: "immediate-or-cancel",
    reduceOnly: true,
    triggerPriceInteger: leg.triggerPriceInteger,
    orderExpiryMs: plan.orderExpiryMs,
    clientOrderIndexPolicy: plan.clientOrderIndexPolicy,
    providerVersion: "lighter-order-preview-v1",
    credentialReference: plan.credentialReference,
    nonceScope: plan.nonceScope,
  };
}

function invalidRequest(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Run a fresh Lighter OCO preview and approve the exact group again.",
  );
}
