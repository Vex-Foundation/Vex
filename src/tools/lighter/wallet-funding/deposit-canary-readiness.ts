/** Read-only acceptance boundary for the Phase 2 minimum-value mainnet canary. */

import type { LighterDepositPreflightSnapshot } from "./deposit-preflight.js";
import { LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE } from "./deposit-preflight.js";
import {
  LIGHTER_DEPOSIT_CHAIN_ID,
  LIGHTER_DEPOSIT_ROUTE_TYPE,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
  LIGHTER_USDC_ASSET_INDEX,
} from "./constants.js";

/** Phase 2 permits no more than one USDC in the first controlled canary. */
export const LIGHTER_DEPOSIT_CANARY_MAX_UNITS = 1_000_000n;

export interface LighterDepositCanaryReadiness {
  readonly readyForExplicitApproval: true;
  readonly signingPerformed: false;
  readonly broadcastPerformed: false;
  readonly requiresSeparateExplicitFundMovementApproval: true;
  readonly walletAddress: string;
  readonly chainId: number;
  readonly route: "perps";
  readonly amountUnits: string;
  readonly amountDisplay: string;
  readonly minimumTransferUnits: string;
  readonly approvalRequired: boolean;
  readonly approveGasLimit: string;
  readonly depositGasLimit: string;
  readonly totalMaxFeeWei: string;
  readonly nativeReserveWei: string;
  readonly requiredNativeBalanceWei: string;
  readonly ethereumBlockNumber: string;
  readonly observedAt: string;
}

/**
 * Prove a live preflight is suitable for the first controlled canary.
 * This accepts only Lighter's exact live minimum and caps it at one USDC.
 */
export function buildLighterDepositCanaryReadiness(
  snapshot: LighterDepositPreflightSnapshot,
): LighterDepositCanaryReadiness {
  const amount = positiveUnits(snapshot.amountUnits, "canary amount");
  const minimum = positiveUnits(snapshot.minimumTransferUnits, "live minimum transfer");
  if (!LIGHTER_DEPOSIT_FEE_PREFLIGHT_COMPLETE) {
    throw new Error("Lighter deposit execution safety checks are not complete.");
  }
  if (
    snapshot.chainId !== LIGHTER_DEPOSIT_CHAIN_ID
    || snapshot.assetIndex !== LIGHTER_USDC_ASSET_INDEX
    || snapshot.routeType !== LIGHTER_DEPOSIT_ROUTE_TYPE.perps
    || snapshot.settlementTokenSymbol !== "USDC"
    || snapshot.settlementTokenDecimals !== LIGHTER_SETTLEMENT_ASSET_DECIMALS
  ) {
    throw new Error("The live preflight is not the supported Ethereum USDC-perps canary route.");
  }
  if (amount !== minimum) {
    throw new Error("The Phase 2 canary must use Lighter's exact live minimum transfer amount.");
  }
  if (amount > LIGHTER_DEPOSIT_CANARY_MAX_UNITS) {
    throw new Error("Lighter's live minimum exceeds the one-USDC Phase 2 canary cap.");
  }
  const observedAt = snapshot.observedAt.toISOString();
  return {
    readyForExplicitApproval: true,
    signingPerformed: false,
    broadcastPerformed: false,
    requiresSeparateExplicitFundMovementApproval: true,
    walletAddress: snapshot.walletAddress,
    chainId: snapshot.chainId,
    route: "perps",
    amountUnits: snapshot.amountUnits,
    amountDisplay: formatUsdc(amount),
    minimumTransferUnits: snapshot.minimumTransferUnits,
    approvalRequired: snapshot.approvalRequired,
    approveGasLimit: snapshot.approveGasLimit,
    depositGasLimit: snapshot.depositGasLimit,
    totalMaxFeeWei: snapshot.totalMaxFeeWei,
    nativeReserveWei: snapshot.nativeReserveWei,
    requiredNativeBalanceWei: snapshot.requiredNativeBalanceWei,
    ethereumBlockNumber: snapshot.ethereumBlockNumber,
    observedAt,
  };
}

function positiveUnits(value: string, field: string): bigint {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`The ${field} is not a positive integer.`);
  }
  return BigInt(value);
}

function formatUsdc(units: bigint): string {
  const scale = 10n ** BigInt(LIGHTER_SETTLEMENT_ASSET_DECIMALS);
  const whole = units / scale;
  const fraction = (units % scale).toString().padStart(LIGHTER_SETTLEMENT_ASSET_DECIMALS, "0")
    .replace(/0+$/, "");
  return `${whole}${fraction.length === 0 ? "" : `.${fraction}`} USDC`;
}
