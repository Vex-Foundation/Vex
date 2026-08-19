import type { LighterTradingCredentialVaultReference } from "@tools/lighter/trading-credentials.js";
import type { LighterWithdrawalIntentRow } from "@vex-agent/db/repos/lighter-withdrawal-intents.js";
import { ErrorCodes, VexError } from "../../../../errors.js";

export interface LighterCoreWithdrawalReadyForSignerPlan {
  readonly intentId: string;
  readonly previewId: string;
  readonly sessionId: string;
  readonly matchHash: string;
  readonly environment: "core";
  readonly endpoint: string;
  readonly signingChainId: 304;
  readonly settlementChainId: 1;
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
    readonly environment: "core";
    readonly accountIndex: number;
    readonly apiKeyIndex: number;
  };
}

export function buildLighterCoreWithdrawalReadyForSignerPlan(
  intent: LighterWithdrawalIntentRow,
): LighterCoreWithdrawalReadyForSignerPlan {
  const credential = intent.credentialRefJson;
  if (
    intent.environment !== "core"
    || intent.operationClass !== "secure_l2_withdrawal"
    || intent.signingChainId !== 304
    || intent.settlementChainId !== 1
    || intent.assetIndex !== 3
    || intent.assetSymbol !== "USDC"
    || intent.assetDecimals !== 6
    || intent.routeType !== 0
    || intent.walletAddress.toLowerCase() !== intent.destinationAddress.toLowerCase()
    || intent.approvalStatus !== "approved"
    || intent.executionState !== "approved"
    || credential.kind !== "encrypted_vault_reference"
    || credential.environment !== "core"
    || credential.accountIndex !== intent.accountIndex
    || credential.apiKeyIndex !== intent.apiKeyIndex
    || !/^[1-9][0-9]*$/.test(intent.amountUnits)
    || !/^[0-9a-f]{64}$/.test(intent.matchHash)
  ) {
    throw invalid("The approved Core withdrawal intent is not ready for the constrained signer.");
  }
  const snapshot = intent.preflightJson;
  const settlementScanFromBlock = snapshot.settlementBlockNumber;
  if (typeof settlementScanFromBlock !== "string" || !/^\d+$/.test(settlementScanFromBlock)) {
    throw invalid("The Core withdrawal intent has no verified Ethereum scan start block.");
  }
  return {
    intentId: intent.intentId,
    previewId: intent.previewId,
    sessionId: intent.sessionId,
    matchHash: intent.matchHash,
    environment: "core",
    endpoint: intent.endpoint,
    signingChainId: 304,
    settlementChainId: 1,
    accountIndex: intent.accountIndex,
    apiKeyIndex: intent.apiKeyIndex,
    walletAddress: intent.walletAddress,
    destinationAddress: intent.destinationAddress,
    assetIndex: 3,
    assetDecimals: 6,
    settlementTokenAddress: intent.settlementTokenAddress,
    routeType: 0,
    amountUnits: intent.amountUnits,
    gatewayAddress: intent.gatewayAddress,
    gatewayImplementation: intent.gatewayImplementation,
    gatewayCodeHash: intent.gatewayCodeHash,
    settlementTokenCodeHash: intent.settlementTokenCodeHash,
    settlementScanFromBlock,
    credentialReference: credential,
    nonceScope: {
      environment: "core",
      accountIndex: intent.accountIndex,
      apiKeyIndex: intent.apiKeyIndex,
    },
  };
}

function invalid(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "No withdrawal was signed or submitted. Prepare and approve a fresh exact Core USDC withdrawal.",
  );
}
