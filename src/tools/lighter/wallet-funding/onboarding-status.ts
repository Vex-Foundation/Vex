/**
 * Read-only orchestration for Lighter wallet-funded account onboarding status.
 *
 * Composes the live reads (wallet settlement balance + acquire capability,
 * Lighter account, Vex trading-key presence) into an observation, then returns
 * the account state plus the pure onboarding plan. Readers are injected so this
 * orchestration is unit-testable without a network, and so the privileged
 * trading-key check can be supplied by a caller that can see the vault while
 * this module stays key-free. No signing, no funds, no mutation.
 */

import type { LighterEnvironment } from "../constants.js";
import {
  deriveLighterOnboardingObservation,
  type LighterAccountCollateralRow,
} from "./onboarding-observation.js";
import {
  decimalToBaseUnits,
  planLighterOnboarding,
  type LighterOnboardingPlan,
} from "./onboarding-plan.js";
import {
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
} from "./constants.js";

export interface LighterOnboardingReaders {
  /** Settlement asset (USDC) base units the wallet holds on the deposit chain. */
  readWalletSettlementUnits(walletAddress: string): Promise<bigint>;
  /** Whether the wallet holds a swappable asset to acquire more settlement asset. */
  readWalletCanAcquireSettlement(walletAddress: string): Promise<boolean>;
  /** The Lighter account owned by the wallet's L1 address, or null if none. */
  readLighterAccount(
    environment: LighterEnvironment,
    walletAddress: string,
  ): Promise<LighterAccountCollateralRow | null>;
  /** Whether a Vex-controlled trading key is registered on the account. */
  readVexTradingKeyRegistered(
    environment: LighterEnvironment,
    accountIndex: number,
  ): Promise<boolean>;
}

export interface LighterOnboardingStatusInput {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  /** Settlement base units the intended position requires (0 when unspecified). */
  readonly requiredCollateralUnits: bigint;
}

export interface LighterOnboardingStatus {
  readonly environment: LighterEnvironment;
  readonly walletAddress: string;
  readonly walletSettlementUnits: string;
  readonly walletCanAcquireSettlement: boolean;
  readonly accountExists: boolean;
  readonly accountIndex: number | null;
  readonly accountCollateralUnits: string;
  readonly tradingKeyRegistered: boolean;
  readonly requiredCollateralUnits: string;
  readonly fundingAssessment: LighterFundingAssessment;
  readonly plan: {
    readonly legs: readonly { readonly kind: string; readonly reason: string }[];
    readonly ready: boolean;
    readonly blocked: string | null;
    readonly depositUnits: string | null;
    readonly acquireUnits: string | null;
  };
}

export type LighterFundingDecision =
  | "ready"
  | "prepare_deposit"
  | "insufficient_wallet_usdc";

/**
 * Exact live-balance decision for funding an intended Lighter position.
 *
 * Only Ethereum-mainnet USDC is directly depositable. Other wallet assets are
 * deliberately excluded: spending them would require its own live quote and
 * approval, so their presence must never be treated as proof that a deposit can
 * be prepared.
 */
export interface LighterFundingAssessment {
  readonly decision: LighterFundingDecision;
  readonly requiredCollateralUnits: string;
  readonly requiredCollateralDisplay: string;
  readonly lighterCollateralUnits: string;
  readonly lighterCollateralDisplay: string;
  readonly walletUsdcUnits: string;
  readonly walletUsdcDisplay: string;
  readonly combinedUsdcUnits: string;
  readonly combinedUsdcDisplay: string;
  readonly collateralShortfallUnits: string;
  readonly collateralShortfallDisplay: string;
  readonly depositUnits: string | null;
  readonly depositAmountIn: string | null;
  readonly depositDisplay: string | null;
  readonly walletDepositShortfallUnits: string;
  readonly walletDepositShortfallDisplay: string;
  readonly minimumDepositDisplay: string;
}

const LIGHTER_DEPOSIT_MIN_UNITS = decimalToBaseUnits(
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
);

export function assessLighterFunding(input: {
  readonly walletSettlementUnits: bigint;
  readonly accountCollateralUnits: bigint;
  readonly requiredCollateralUnits: bigint;
}): LighterFundingAssessment {
  assertNonNegativeFundingUnits("walletSettlementUnits", input.walletSettlementUnits);
  assertNonNegativeFundingUnits("accountCollateralUnits", input.accountCollateralUnits);
  assertNonNegativeFundingUnits("requiredCollateralUnits", input.requiredCollateralUnits);

  const collateralShortfall = maxUnits(
    input.requiredCollateralUnits - input.accountCollateralUnits,
    0n,
  );
  const depositUnits = collateralShortfall === 0n
    ? null
    : maxUnits(collateralShortfall, LIGHTER_DEPOSIT_MIN_UNITS);
  const walletDepositShortfall = depositUnits === null
    ? 0n
    : maxUnits(depositUnits - input.walletSettlementUnits, 0n);
  const decision: LighterFundingDecision = depositUnits === null
    ? "ready"
    : walletDepositShortfall === 0n
      ? "prepare_deposit"
      : "insufficient_wallet_usdc";

  return {
    decision,
    requiredCollateralUnits: input.requiredCollateralUnits.toString(),
    requiredCollateralDisplay: displaySettlementUnits(input.requiredCollateralUnits),
    lighterCollateralUnits: input.accountCollateralUnits.toString(),
    lighterCollateralDisplay: displaySettlementUnits(input.accountCollateralUnits),
    walletUsdcUnits: input.walletSettlementUnits.toString(),
    walletUsdcDisplay: displaySettlementUnits(input.walletSettlementUnits),
    combinedUsdcUnits: (input.accountCollateralUnits + input.walletSettlementUnits).toString(),
    combinedUsdcDisplay: displaySettlementUnits(
      input.accountCollateralUnits + input.walletSettlementUnits,
    ),
    collateralShortfallUnits: collateralShortfall.toString(),
    collateralShortfallDisplay: displaySettlementUnits(collateralShortfall),
    depositUnits: depositUnits?.toString() ?? null,
    depositAmountIn: depositUnits === null ? null : formatSettlementUnits(depositUnits),
    depositDisplay: depositUnits === null ? null : displaySettlementUnits(depositUnits),
    walletDepositShortfallUnits: walletDepositShortfall.toString(),
    walletDepositShortfallDisplay: displaySettlementUnits(walletDepositShortfall),
    minimumDepositDisplay: displaySettlementUnits(LIGHTER_DEPOSIT_MIN_UNITS),
  };
}

export async function resolveLighterOnboardingStatus(
  readers: LighterOnboardingReaders,
  input: LighterOnboardingStatusInput,
): Promise<LighterOnboardingStatus> {
  const account = await readers.readLighterAccount(input.environment, input.walletAddress);
  const vexTradingKeyRegistered = account
    ? await readers.readVexTradingKeyRegistered(input.environment, account.account_index)
    : false;
  const walletSettlementUnits = await readers.readWalletSettlementUnits(input.walletAddress);
  const walletCanAcquireSettlement = await readers.readWalletCanAcquireSettlement(input.walletAddress);

  const observation = deriveLighterOnboardingObservation({
    environment: input.environment,
    account,
    vexTradingKeyRegistered,
    walletSettlementUnits,
    walletCanAcquireSettlement,
    requiredCollateralUnits: input.requiredCollateralUnits,
  });

  const plan = planLighterOnboarding(observation);
  const fundingAssessment = assessLighterFunding({
    walletSettlementUnits,
    accountCollateralUnits: observation.accountCollateralUnits,
    requiredCollateralUnits: input.requiredCollateralUnits,
  });

  return {
    environment: input.environment,
    walletAddress: input.walletAddress,
    walletSettlementUnits: walletSettlementUnits.toString(),
    walletCanAcquireSettlement,
    accountExists: observation.accountExists,
    accountIndex: account?.account_index ?? null,
    accountCollateralUnits: observation.accountCollateralUnits.toString(),
    tradingKeyRegistered: observation.tradingKeyRegistered,
    requiredCollateralUnits: input.requiredCollateralUnits.toString(),
    fundingAssessment,
    plan: projectPlan(plan),
  };
}

function formatSettlementUnits(units: bigint): string {
  const scale = 10n ** BigInt(LIGHTER_SETTLEMENT_ASSET_DECIMALS);
  const whole = units / scale;
  const fraction = (units % scale)
    .toString()
    .padStart(LIGHTER_SETTLEMENT_ASSET_DECIMALS, "0")
    .replace(/0+$/, "");
  return fraction.length === 0 ? whole.toString() : `${whole}.${fraction}`;
}

function displaySettlementUnits(units: bigint): string {
  return `${formatSettlementUnits(units)} USDC`;
}

function maxUnits(left: bigint, right: bigint): bigint {
  return left > right ? left : right;
}

function assertNonNegativeFundingUnits(field: string, value: bigint): void {
  if (value < 0n) {
    throw new Error(`Lighter funding assessment ${field} must be non-negative, got ${value}.`);
  }
}

function projectPlan(plan: LighterOnboardingPlan): LighterOnboardingStatus["plan"] {
  return {
    legs: plan.legs.map((leg) => ({ kind: leg.kind, reason: leg.reason })),
    ready: plan.ready,
    blocked: plan.blocked,
    depositUnits: plan.depositUnits === null ? null : plan.depositUnits.toString(),
    acquireUnits: plan.acquireUnits === null ? null : plan.acquireUnits.toString(),
  };
}
