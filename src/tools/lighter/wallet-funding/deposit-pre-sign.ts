/**
 * Approval-bound revalidation for a Lighter deposit.
 *
 * This module is public-read only. It rejects changed identity, a newly
 * required approval leg, stale evidence, and any gas or EIP-1559 ceiling above
 * what the user approved. It owns no signer and cannot submit a transaction.
 */

import { getAddress } from "viem";

import { ErrorCodes, VexError } from "../../../errors.js";
import type { LighterDepositPreflightSnapshot } from "./deposit-preflight.js";

export const LIGHTER_DEPOSIT_PRE_SIGN_MAX_AGE_MS = 30_000;

export type LighterDepositPreSignStage = "execution" | "approve" | "deposit";

export interface LighterDepositSignedFeeCeiling {
  readonly gasLimit: bigint;
  readonly maxFeePerGas: bigint;
  readonly maxPriorityFeePerGas: bigint;
  readonly maxNetworkFeeWei: bigint;
}

export interface LighterDepositApprovedSnapshot {
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
  ) {
    throw revalidationError("Live chain or Lighter metadata no longer matches the approved deposit.");
  }
  if (BigInt(fresh.ethereumBlockNumber) < BigInt(intent.preflightEthereumBlockNumber)) {
    throw revalidationError("Ethereum head moved behind the approved preflight block.");
  }

  const approved = approvedFeeCeiling(intent, stage === "deposit" ? "deposit" : "approve");
  const freshGasLimit = BigInt(
    stage === "deposit" ? fresh.depositGasLimit : fresh.approveGasLimit,
  );
  const freshMaxFee = BigInt(
    stage === "deposit" ? fresh.depositMaxFeeWei : fresh.approveMaxFeeWei,
  );
  if (
    stage !== "deposit"
    && fresh.approvalRequired
    && BigInt(intent.preflightApproveGasLimit ?? "0") === 0n
  ) {
    throw revalidationError(
      "USDC allowance fell below the approved amount and would add an unapproved transaction.",
    );
  }
  if (
    freshGasLimit > approved.gasLimit
    || BigInt(fresh.maxFeePerGasWei) > approved.maxFeePerGas
    || BigInt(fresh.maxPriorityFeePerGasWei) > approved.maxPriorityFeePerGas
    || freshMaxFee > approved.maxNetworkFeeWei
  ) {
    throw revalidationError("Live gas or fee exposure exceeds the user's approved ceiling.");
  }
}

export function approvedFeeCeiling(
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
    throw revalidationError(`The approved ${stage} fee ceiling is inconsistent.`);
  }
  return { gasLimit, maxFeePerGas, maxPriorityFeePerGas, maxNetworkFeeWei };
}

function parseRequiredInteger(value: string | null, field: string): bigint {
  if (value === null || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw revalidationError(`The approved ${field} is missing or invalid.`);
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
