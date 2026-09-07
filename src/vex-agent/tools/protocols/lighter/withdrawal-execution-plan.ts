import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import { getLighterSecureWithdrawalProfile } from "@tools/lighter/withdrawal/profiles.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

export interface LighterWithdrawalReadyForSignerPlan {
  readonly intentId: string;
  readonly previewId: string;
  readonly sessionId: string;
  readonly matchHash: string;
  readonly environment: "core" | "rhc";
  readonly endpoint: string;
  readonly signingChainId: 304 | 466324;
  readonly settlementChainId: 1 | 4663;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
  readonly walletAddress: string;
  readonly destinationAddress: string;
  readonly assetIndex: 3;
  readonly assetDecimals: 6;
  readonly settlementTokenAddress: string;
  readonly routeType: 0;
  readonly amountUnits: string;
  readonly gatewayAddress: string;
  readonly gatewayImplementation: string;
  readonly gatewayCodeHash: string;
  readonly settlementTokenCodeHash: string;
  readonly settlementScanFromBlock: string;
  readonly credentialReference: LighterTradingCredentialVaultReference;
  readonly nonceScope: {
    readonly environment: "core" | "rhc";
    readonly accountIndex: number;
    readonly apiKeyIndex: number;
  };
}

export type LighterCoreWithdrawalReadyForSignerPlan = LighterWithdrawalReadyForSignerPlan & {
  readonly environment: "core";
  readonly signingChainId: 304;
  readonly settlementChainId: 1;
};

export function buildLighterCoreWithdrawalReadyForSignerPlan(
  intent: LighterWithdrawalIntentRow,
): LighterCoreWithdrawalReadyForSignerPlan {
  const plan = buildLighterWithdrawalReadyForSignerPlan(intent);
  if (plan.environment !== "core") throw invalid("The withdrawal intent is not a Core withdrawal.");
  return plan as LighterCoreWithdrawalReadyForSignerPlan;
}

export function buildLighterWithdrawalReadyForSignerPlan(
  intent: LighterWithdrawalIntentRow,
): LighterWithdrawalReadyForSignerPlan {
  const credential = intent.credentialRefJson;
  const profile = getLighterSecureWithdrawalProfile(intent.environment);
  if (
    intent.operationClass !== "secure_l2_withdrawal"
    || intent.signingChainId !== profile.signingChainId
    || intent.settlementChainId !== profile.settlementChainId
    || intent.assetIndex !== profile.assetIndex
    || intent.assetSymbol !== profile.assetSymbol
    || intent.assetDecimals !== profile.assetDecimals
    || intent.routeType !== profile.routeType
    || intent.walletAddress.toLowerCase() !== intent.destinationAddress.toLowerCase()
    || intent.approvalStatus !== "approved"
    || intent.executionState !== "approved"
    || credential.kind !== "encrypted_vault_reference"
    || credential.environment !== intent.environment
    || credential.accountIndex !== intent.accountIndex
    || credential.apiKeyIndex !== intent.apiKeyIndex
    || !/^[1-9][0-9]*$/.test(intent.amountUnits)
    || !/^[0-9a-f]{64}$/.test(intent.matchHash)
  ) {
    throw invalid(`The approved ${profile.sourceName} withdrawal intent is not ready for the constrained signer.`);
  }
  const snapshot = intent.preflightJson;
  const settlementScanFromBlock = snapshot.settlementBlockNumber;
  if (typeof settlementScanFromBlock !== "string" || !/^\d+$/.test(settlementScanFromBlock)) {
    throw invalid(`The ${profile.sourceName} withdrawal intent has no verified settlement scan start block.`);
  }
  return {
    intentId: intent.intentId,
    previewId: intent.previewId,
    sessionId: intent.sessionId,
    matchHash: intent.matchHash,
    environment: intent.environment,
    endpoint: intent.endpoint,
    signingChainId: profile.signingChainId,
    settlementChainId: profile.settlementChainId,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    walletAddress: intent.walletAddress,
    destinationAddress: intent.destinationAddress,
    assetIndex: profile.assetIndex,
    assetDecimals: profile.assetDecimals,
    settlementTokenAddress: intent.settlementTokenAddress,
    routeType: profile.routeType,
    amountUnits: intent.amountUnits,
    gatewayAddress: intent.gatewayAddress,
    gatewayImplementation: intent.gatewayImplementation,
    gatewayCodeHash: intent.gatewayCodeHash,
    settlementTokenCodeHash: intent.settlementTokenCodeHash,
    settlementScanFromBlock,
    credentialReference: credential,
    nonceScope: {
      environment: intent.environment,
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    },
  };
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No withdrawal was signed or submitted. Prepare and approve a fresh exact environment-scoped withdrawal.",
  );
}
