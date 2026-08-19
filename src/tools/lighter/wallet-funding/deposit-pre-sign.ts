/**
 * Signer-adjacent revalidation for an approved Lighter deposit.
 *
 * This module is public-read only. It rejects changed identity, a newly
 * required approval leg, and stale evidence. Gas is intentionally not part of
 * the user approval: a fresh EIP-1559 estimate is selected beside the signer.
 * A generous live-data-derived limit remains as a provider sanity boundary.
 * This module owns no signer and cannot submit a transaction.
 */

import { getAddress } from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import type { LighterDepositPreflightSnapshot } from "./deposit-preflight.js";
import type { LighterEnvironment } from "../constants.js";

export const LIGHTER_DEPOSIT_PRE_SIGN_MAX_AGE_MS = 30_000;
export const LIGHTER_DEPOSIT_RUNTIME_FEE_SANITY_MULTIPLIER = 4n;

export type LighterDepositPreSignStage = "execution" | "approve" | "deposit";

export interface LighterDepositSignedFeeCeiling {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxNetworkFeeWei: bigint;
}

export interface LighterDepositApprovedSnapshot {
  readonly environment?: LighterEnvironment;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly depositContract: string | null;
  readonly depositTo: string | null;
  readonly assetIndex: number | null;
  readonly routeType: number | null;
  readonly amountUnits: string | null;
  readonly settlementTokenAddress: string | null;
  readonly settlementTokenSymbol: string | null;
  readonly settlementTokenDecimals: number | null;
  readonly preflightEthereumBlockNumber: string | null;
  readonly preflightApproveGasLimit: string | null;
  readonly preflightDepositGasLimit: string | null;
  readonly preflightMaxFeePerGasWei: string | null;
  readonly preflightMaxPriorityFeePerGasWei: string | null;
  readonly preflightApproveMaxFeeWei: string | null;
  readonly preflightDepositMaxFeeWei: string | null;
  readonly preflightPublicSnapshot?: Pick<
    LighterDepositPreflightSnapshot,
    | "lighterRestBaseUrl"
    | "settlementNetworkName"
    | "gatewayImplementationAddress"
    | "gatewayCodeHash"
    | "settlementTokenImplementationAddress"
    | "settlementTokenCodeHash"
    | "depositCalldata"
    | "depositValueWei"
  > | null;
}

export function assertLighterDepositPreflightWithinApproval(input: {
  readonly intent: LighterDepositApprovedSnapshot;
  readonly fresh: LighterDepositPreflightSnapshot;
  readonly stage: LighterDepositPreSignStage;
  readonly now?: Date;
}): void {
  const { intent, fresh, stage } = input;
  const now = input.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw revalidationError("The local clock is invalid.");
  const ageMs = now.getTime() - fresh.observedAt.getTime();
  if (ageMs < -5_000 || ageMs > LIGHTER_DEPOSIT_PRE_SIGN_MAX_AGE_MS) {
    throw revalidationError("The refreshed Lighter deposit preflight is stale.");
  }

  if (
    intent.amountUnits === null
    || intent.depositTo === null
    || intent.depositContract === null
    || intent.assetIndex === null
    || intent.routeType === null
    || intent.preflightEthereumBlockNumber === null
    || (intent.environment !== undefined && fresh.environment !== intent.environment)
    || getAddress(fresh.walletAddress) !== getAddress(intent.walletAddress)
    || fresh.chainId !== intent.chainId
    || getAddress(fresh.gatewayAddress) !== getAddress(intent.depositContract)
    || getAddress(fresh.walletAddress) !== getAddress(intent.depositTo)
    || fresh.assetIndex !== intent.assetIndex
    || fresh.routeType !== intent.routeType
    || fresh.amountUnits !== intent.amountUnits
    || fresh.settlementTokenAddress.toLowerCase()
      !== intent.settlementTokenAddress?.toLowerCase()
    || fresh.settlementTokenSymbol !== intent.settlementTokenSymbol
    || fresh.settlementTokenDecimals !== intent.settlementTokenDecimals
    || fresh.beneficiaryAddress.toLowerCase() !== intent.depositTo.toLowerCase()
    || fresh.depositValueWei !== "0"
  ) {
    throw revalidationError("Live chain or Lighter metadata no longer matches the approved deposit.");
  }
  const approvedPublic = intent.preflightPublicSnapshot;
  if (
    approvedPublic !== undefined
    && approvedPublic !== null
    && (
      fresh.lighterRestBaseUrl !== approvedPublic.lighterRestBaseUrl
      || fresh.settlementNetworkName !== approvedPublic.settlementNetworkName
      || fresh.gatewayImplementationAddress?.toLowerCase()
        !== approvedPublic.gatewayImplementationAddress?.toLowerCase()
      || fresh.gatewayCodeHash.toLowerCase() !== approvedPublic.gatewayCodeHash.toLowerCase()
      || fresh.settlementTokenImplementationAddress?.toLowerCase()
        !== approvedPublic.settlementTokenImplementationAddress?.toLowerCase()
      || fresh.settlementTokenCodeHash.toLowerCase()
        !== approvedPublic.settlementTokenCodeHash.toLowerCase()
      || fresh.depositCalldata.toLowerCase() !== approvedPublic.depositCalldata.toLowerCase()
      || fresh.depositValueWei !== approvedPublic.depositValueWei
    )
  ) {
    throw revalidationError(
      "The live public deployment or exact calldata no longer matches the approved deposit.",
    );
  }
  if (BigInt(fresh.ethereumBlockNumber) < BigInt(intent.preflightEthereumBlockNumber)) {
    throw revalidationError("Ethereum head moved behind the approved preflight block.");
  }

  if (
    stage !== "deposit"
    && fresh.approvalRequired
    && BigInt(intent.preflightApproveGasLimit ?? "0") === 0n
  ) {
    throw revalidationError(
      "Settlement-token allowance fell below the approved amount and would add an unapproved transaction.",
    );
  }
}

/**
 * Build a wide abnormal-value boundary from the signer-adjacent live quote.
 * The transaction still signs with the current quote, not this upper bound.
 */
export function runtimeFeeSafetyLimit(
  fresh: LighterDepositPreflightSnapshot,
  stage: "approve" | "deposit",
): LighterDepositSignedFeeCeiling {
  const gasLimit = parseRequiredInteger(
    stage === "approve" ? fresh.approveGasLimit : fresh.depositGasLimit,
    `${stage} gas limit`,
  );
  const currentMaxFeePerGas = parseRequiredInteger(
    fresh.maxFeePerGasWei,
    "current maximum fee per gas",
  );
  const currentMaxPriorityFeePerGas = parseRequiredInteger(
    fresh.maxPriorityFeePerGasWei,
    "current maximum priority fee per gas",
  );
  const maxFeePerGas = currentMaxFeePerGas * LIGHTER_DEPOSIT_RUNTIME_FEE_SANITY_MULTIPLIER;
  const maxPriorityFeePerGas = currentMaxPriorityFeePerGas
    * LIGHTER_DEPOSIT_RUNTIME_FEE_SANITY_MULTIPLIER;
  if (
    (stage === "deposit" && gasLimit === 0n)
    || currentMaxFeePerGas === 0n
    || currentMaxPriorityFeePerGas > currentMaxFeePerGas
    || maxPriorityFeePerGas > maxFeePerGas
  ) {
    throw revalidationError(`The live ${stage} fee estimate is inconsistent.`);
  }
  return {
    gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    maxNetworkFeeWei: gasLimit * maxFeePerGas,
  };
}

/** Historical boundary used only to validate an externally repriced tx. */
export function persistedFeeSafetyLimit(
  intent: LighterDepositApprovedSnapshot,
  stage: "approve" | "deposit",
): LighterDepositSignedFeeCeiling {
  const gasLimit = parseRequiredInteger(
    stage === "approve"
      ? intent.preflightApproveGasLimit
      : intent.preflightDepositGasLimit,
    `${stage} gas limit`,
  );
  const maxFeePerGas = parseRequiredInteger(
    intent.preflightMaxFeePerGasWei,
    "maximum fee per gas",
  );
  const maxPriorityFeePerGas = parseRequiredInteger(
    intent.preflightMaxPriorityFeePerGasWei,
    "maximum priority fee per gas",
  );
  const maxNetworkFeeWei = parseRequiredInteger(
    stage === "approve"
      ? intent.preflightApproveMaxFeeWei
      : intent.preflightDepositMaxFeeWei,
    `${stage} maximum network fee`,
  );
  if (
    (stage === "deposit" && gasLimit === 0n)
    || maxFeePerGas === 0n
    || maxPriorityFeePerGas > maxFeePerGas
    || maxNetworkFeeWei !== gasLimit * maxFeePerGas
  ) {
    throw revalidationError(`The persisted ${stage} fee safety data is inconsistent.`);
  }
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNetworkFeeWei };
}

function parseRequiredInteger(value: string | null, field: string): bigint {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw revalidationError(`The ${field} is missing or invalid.`);
  }
  return BigInt(value);
}

function revalidationError(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Lighter deposit pre-sign revalidation refused execution: ${message} Nothing was signed or submitted.`,
    "Prepare a new deposit approval from fresh live data.",
  );
}
