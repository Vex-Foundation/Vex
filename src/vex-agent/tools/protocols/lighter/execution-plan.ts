import type { LighterOrderExecutionIntentRow } from "@vex-agent/db/repos/lighter-order-execution-intents.js";
import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import { ErrorCodes, VexError } from "../../../../errors.js";
import { assertLighterPhaseOneOrderPolicy } from "@tools/lighter/order-policy.js";

export interface LighterOrderReadyForSignerPlan {
  readonly intentId: string;
  readonly sessionId: string;
  readonly previewId: string;
  readonly matchHash: string;
  readonly environment: LighterOrderExecutionIntentRow["environment"];
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly marketIndex: number;
  readonly side: LighterOrderExecutionIntentRow["side"];
  readonly baseAmountInteger: string;
  readonly priceInteger: string;
  readonly orderType: LighterOrderExecutionIntentRow["orderType"];
  readonly timeInForce: LighterOrderExecutionIntentRow["timeInForce"];
  readonly reduceOnly: boolean;
  readonly triggerPriceInteger: string | null;
  readonly orderExpiryMs: number;
  readonly clientOrderIndexPolicy: string;
  readonly providerVersion: string;
  readonly credentialReference: LighterTradingCredentialVaultReference;
  readonly nonceScope: {
    readonly environment: LighterOrderExecutionIntentRow["environment"];
    readonly accountIndex: number;
    readonly apiKeyIndex: number;
  };
}

export function buildLighterOrderReadyForSignerPlan(
  intent: LighterOrderExecutionIntentRow,
  nowMs = Date.now(),
): LighterOrderReadyForSignerPlan {
  if (intent.approvalStatus !== "approved") {
    throw invalidRequest(
      `Lighter order execution intent ${intent.intentId} is not approved.`,
    );
  }
  if (intent.executionState !== "approval_pending") {
    throw invalidRequest(
      `Lighter order execution intent ${intent.intentId} is already ${intent.executionState}.`,
    );
  }
  if (Date.parse(intent.expiresAt) <= nowMs) {
    throw invalidRequest(
      `Lighter order execution intent ${intent.intentId} expired before signer preparation.`,
    );
  }
  if (intent.nonceReservationId !== null || intent.nonceValue !== null) {
    throw invalidRequest(
      `Lighter order execution intent ${intent.intentId} already has a nonce reservation.`,
    );
  }
  assertLighterPhaseOneOrderPolicy(intent.orderType, intent.timeInForce);
  assertCredentialReferenceMatchesIntent(intent);

  return {
    intentId: intent.intentId,
    sessionId: intent.sessionId,
    previewId: intent.previewId,
    matchHash: intent.matchHash,
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
    triggerPriceInteger: intent.triggerPriceInteger,
    orderExpiryMs: intent.orderExpiryMs,
    clientOrderIndexPolicy: intent.clientOrderIndexPolicy,
    providerVersion: intent.providerVersion,
    credentialReference: intent.credentialRefJson,
    nonceScope: {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    },
  };
}

function assertCredentialReferenceMatchesIntent(
  intent: LighterOrderExecutionIntentRow,
): void {
  const ref = intent.credentialRefJson;
  if (
    ref.kind !== "encrypted_vault_reference"
    || ref.environment !== intent.environment
    || ref.accountIndex !== intent.accountIndex
    || ref.apiKeyIndex !== intent.apiKeyIndex
    || ref.vaultCredentialId.trim().length === 0
  ) {
    throw invalidRequest(
      "Lighter order execution intent credential reference does not match the approved preview scope.",
    );
  }
}

function invalidRequest(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Run a fresh Lighter order preview and approval preparation before trying again.",
  );
}
