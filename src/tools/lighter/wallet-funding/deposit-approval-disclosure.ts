/**
 * Non-spoofable approval-card disclosure for a prepared Lighter deposit.
 *
 * Every display value is recomputed here from the persisted deposit intent —
 * amount from the stored base units, destination from the stored credit
 * address — never from model text, so the human-readable card can never diverge
 * from what the executor will sign. The scope note enforces the trade/withdraw
 * separation at the approval layer: a deposit approval authorizes only a deposit
 * into the user's own account.
 */

import { formatLighterIntegerAmount } from "@tools/lighter/order-preview.js";
import type { LighterOnboardingIntentRow } from "@vex-agent/db/repos/lighter-onboarding-intents.js";
import { ErrorCodes, VexError } from "../../../errors.js";
import {
  LIGHTER_SETTLEMENT_ASSET,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "./constants.js";
import { getLighterFundingDeployment } from "./deployments.js";

const ENVIRONMENT_LABELS = {
  core: "Lighter Core",
  rhc: "Robinhood Chain Lighter",
} as const;

const CHAIN_LABELS: Record<number, string> = {
  1: "Ethereum mainnet",
  4663: "Robinhood Chain mainnet (4663)",
};

const ROUTE_LABELS: Record<number, string> = { 0: "perps", 1: "spot" };

export interface LighterDepositApprovalDisclosure {
  readonly environmentLabel: string;
  readonly settlementAsset: string;
  readonly amountDisplay: string;
  readonly walletBalanceDisplay: string;
  readonly walletAllowanceDisplay: string;
  readonly nativeBalanceDisplay: string;
  readonly approvalRequired: boolean;
  readonly settlementTokenAddress: string;
  readonly settlementTokenDecimals: number;
  readonly minimumTransferUnits: string;
  readonly walletBalanceUnits: string;
  readonly walletAllowanceUnits: string;
  readonly ethereumBlockNumber: string;
  readonly lighterBlockNumber: string;
  readonly preflightObservedAt: string;
  readonly creditAddress: string;
  readonly depositContract: string;
  readonly beneficiaryAddress: string;
  readonly approvalSpender: string;
  readonly depositCalldata: string;
  readonly depositValueWei: "0";
  readonly chainLabel: string;
  readonly routeLabel: string;
  readonly createsAccountNote: string;
  readonly scopeNote: string;
  readonly summary: string;
}

export function buildLighterDepositApprovalDisclosure(
  intent: LighterOnboardingIntentRow,
): LighterDepositApprovalDisclosure {
  if (intent.capability !== "deposit") {
    throw disclosureUnavailable("This approval disclosure is only for Lighter deposit intents.");
  }
  if (
    intent.amountUnits === null
    || intent.depositTo === null
    || intent.depositContract === null
    || intent.assetIndex === null
    || intent.routeType === null
    || typeof intent.settlementTokenAddress !== "string"
    || typeof intent.settlementTokenDecimals !== "number"
    || !Number.isInteger(intent.settlementTokenDecimals)
    || typeof intent.preflightMinimumTransferUnits !== "string"
    || typeof intent.preflightWalletBalanceUnits !== "string"
    || typeof intent.preflightWalletAllowanceUnits !== "string"
    || typeof intent.preflightWalletNativeBalanceWei !== "string"
    || typeof intent.preflightEthereumBlockNumber !== "string"
    || typeof intent.preflightLighterBlockNumber !== "string"
    || !(intent.preflightObservedAt instanceof Date)
    || typeof intent.preflightApproveGasLimit !== "string"
    || typeof intent.preflightDepositGasLimit !== "string"
    || typeof intent.preflightMaxFeePerGasWei !== "string"
    || typeof intent.preflightMaxPriorityFeePerGasWei !== "string"
    || typeof intent.preflightApproveMaxFeeWei !== "string"
    || typeof intent.preflightDepositMaxFeeWei !== "string"
    || typeof intent.preflightTotalMaxFeeWei !== "string"
    || typeof intent.preflightNativeReserveWei !== "string"
    || typeof intent.preflightRequiredNativeBalanceWei !== "string"
  ) {
    throw disclosureUnavailable("The Lighter deposit intent is missing required deposit or preflight fields.");
  }

  const settlementAsset = LIGHTER_SETTLEMENT_ASSET[intent.environment];
  const funding = getLighterFundingDeployment(intent.environment);
  const publicSnapshot = intent.preflightPublicSnapshot ?? null;
  if (
    intent.chainId !== funding.settlementChainId
    || intent.depositContract.toLowerCase() !== funding.gatewayProxy.toLowerCase()
    || intent.settlementTokenAddress.toLowerCase() !== funding.settlementTokenProxy.toLowerCase()
    || intent.settlementTokenSymbol !== funding.settlementSymbol
    || intent.settlementTokenDecimals !== funding.settlementDecimals
    || intent.assetIndex !== funding.settlementAssetIndex
    || intent.routeType !== funding.perpsRouteType
    || intent.depositTo.toLowerCase() !== intent.walletAddress.toLowerCase()
    || publicSnapshot === null
    || (publicSnapshot !== null && (
      publicSnapshot.environment !== intent.environment
      || publicSnapshot.chainId !== intent.chainId
      || publicSnapshot.beneficiaryAddress.toLowerCase() !== intent.depositTo.toLowerCase()
      || publicSnapshot.gatewayAddress.toLowerCase() !== intent.depositContract.toLowerCase()
      || publicSnapshot.settlementTokenAddress.toLowerCase()
        !== intent.settlementTokenAddress.toLowerCase()
      || publicSnapshot.amountUnits !== intent.amountUnits
      || publicSnapshot.assetIndex !== intent.assetIndex
      || publicSnapshot.routeType !== intent.routeType
      || publicSnapshot.depositValueWei !== "0"
      || !/^0x8a857083[0-9a-f]+$/i.test(publicSnapshot.depositCalldata)
    ))
  ) {
    throw disclosureUnavailable(
      "The Lighter deposit intent does not match the environment-bound public action identity.",
    );
  }
  const amount = formatLighterIntegerAmount(
    parseAmountUnits(intent.amountUnits),
    LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  );
  const amountDisplay = `${amount} ${settlementAsset}`;
  const walletBalance = parseNonNegativeUnits(intent.preflightWalletBalanceUnits, "wallet balance");
  const walletAllowance = parseNonNegativeUnits(intent.preflightWalletAllowanceUnits, "wallet allowance");
  const nativeBalance = parseNonNegativeUnits(intent.preflightWalletNativeBalanceWei, "native balance");
  const approveGasLimit = parseNonNegativeUnits(intent.preflightApproveGasLimit, "approval gas limit");
  const depositGasLimit = parsePositiveUnits(intent.preflightDepositGasLimit, "deposit gas limit");
  const maxFeePerGas = parsePositiveUnits(intent.preflightMaxFeePerGasWei, "maximum fee per gas");
  const maxPriorityFeePerGas = parseNonNegativeUnits(
    intent.preflightMaxPriorityFeePerGasWei,
    "maximum priority fee per gas",
  );
  const approveMaxFee = parseNonNegativeUnits(intent.preflightApproveMaxFeeWei, "approval maximum fee");
  const depositMaxFee = parsePositiveUnits(intent.preflightDepositMaxFeeWei, "deposit maximum fee");
  const totalMaxFee = parsePositiveUnits(intent.preflightTotalMaxFeeWei, "total maximum fee");
  const nativeReserve = parsePositiveUnits(intent.preflightNativeReserveWei, "native reserve");
  const requiredNativeBalance = parsePositiveUnits(
    intent.preflightRequiredNativeBalanceWei,
    "required native balance",
  );
  const minimumTransfer = parseNonNegativeUnits(
    intent.preflightMinimumTransferUnits,
    "minimum transfer",
  );
  const walletBalanceDisplay = `${formatLighterIntegerAmount(walletBalance, LIGHTER_SETTLEMENT_ASSET_DECIMALS)} ${settlementAsset}`;
  const walletAllowanceDisplay = `${formatLighterIntegerAmount(walletAllowance, LIGHTER_SETTLEMENT_ASSET_DECIMALS)} ${settlementAsset}`;
  const nativeBalanceDisplay = `${formatLighterIntegerAmount(nativeBalance, 18)} ETH`;
  if (walletBalance < parseAmountUnits(intent.amountUnits) || minimumTransfer > parseAmountUnits(intent.amountUnits)) {
    throw disclosureUnavailable("The persisted Lighter deposit preflight no longer proves a preparable amount.");
  }
  const approvalRequired = walletAllowance < parseAmountUnits(intent.amountUnits);
  if (
    (approvalRequired && approveGasLimit === 0n)
    || (!approvalRequired && approveGasLimit !== 0n)
    || maxPriorityFeePerGas > maxFeePerGas
    || approveMaxFee !== approveGasLimit * maxFeePerGas
    || depositMaxFee !== depositGasLimit * maxFeePerGas
    || totalMaxFee !== approveMaxFee + depositMaxFee
    || nativeReserve !== (approveMaxFee > depositMaxFee ? approveMaxFee : depositMaxFee)
    || requiredNativeBalance !== totalMaxFee + nativeReserve
    || nativeBalance < requiredNativeBalance
  ) {
    throw disclosureUnavailable("The persisted Lighter deposit fee preflight is incomplete or inconsistent.");
  }
  const environmentLabel = ENVIRONMENT_LABELS[intent.environment];
  const chainLabel = CHAIN_LABELS[intent.chainId] ?? `chain ${intent.chainId}`;
  const routeLabel = ROUTE_LABELS[intent.routeType] ?? `route ${intent.routeType}`;

  return {
    environmentLabel,
    settlementAsset,
    amountDisplay,
    walletBalanceDisplay,
    walletAllowanceDisplay,
    nativeBalanceDisplay,
    approvalRequired,
    settlementTokenAddress: intent.settlementTokenAddress,
    settlementTokenDecimals: intent.settlementTokenDecimals,
    minimumTransferUnits: intent.preflightMinimumTransferUnits,
    walletBalanceUnits: intent.preflightWalletBalanceUnits,
    walletAllowanceUnits: intent.preflightWalletAllowanceUnits,
    ethereumBlockNumber: intent.preflightEthereumBlockNumber,
    lighterBlockNumber: intent.preflightLighterBlockNumber,
    preflightObservedAt: intent.preflightObservedAt.toISOString(),
    creditAddress: intent.depositTo,
    depositContract: intent.depositContract,
    beneficiaryAddress: intent.depositTo,
    approvalSpender: intent.depositContract,
    depositCalldata: publicSnapshot?.depositCalldata ?? "",
    depositValueWei: "0",
    chainLabel,
    routeLabel,
    createsAccountNote:
      "If this is your wallet's first Lighter deposit, it creates a new Lighter account owned by this wallet.",
    scopeNote:
      "This approval authorizes only a deposit into your own Lighter perps account and, when needed, the exact settlement-token allowance for it. ETH is used only for network fees. It does not place any trade or include a swap, bridge, transfer, withdrawal, or key registration; key registration and any later trade require separate approvals.",
    summary:
      `Fund your ${environmentLabel} ${routeLabel} account with ${amountDisplay} from ${intent.depositTo} on ${chainLabel}.`,
  };
}

function parseAmountUnits(value: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw disclosureUnavailable("Stored Lighter deposit amount is not a positive integer.");
  }
  return BigInt(value);
}

function parseNonNegativeUnits(value: string, field: string): bigint {
  if (!/^(?:0|[1-9][0-9]*)$/.test(value)) {
    throw disclosureUnavailable(`Stored Lighter deposit ${field} is not a non-negative integer.`);
  }
  return BigInt(value);
}

function parsePositiveUnits(value: string, field: string): bigint {
  const parsed = parseNonNegativeUnits(value, field);
  if (parsed === 0n) {
    throw disclosureUnavailable(`Stored Lighter deposit ${field} must be positive.`);
  }
  return parsed;
}

function disclosureUnavailable(message: string): VexError {
  return new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    message,
    "Prepare the Lighter deposit again from a fresh onboarding status.",
  );
}
