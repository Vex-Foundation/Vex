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
  planLighterOnboarding,
  type LighterOnboardingPlan,
} from "./onboarding-plan.js";
import { LIGHTER_SETTLEMENT_ASSET_DECIMALS } from "./constants.js";
import { getLighterFundingDeployment } from "./deployments.js";

export interface LighterOnboardingReaders {
  /** Settlement asset (USDC) base units the wallet holds on the deposit chain. */
  readWalletSettlementUnits(
    environment: LighterEnvironment,
    walletAddress: string,
  ): Promise<bigint>;
  /** Current settlement-token allowance to the exact environment gateway. */
  readWalletSettlementAllowanceUnits(
    environment: LighterEnvironment,
    walletAddress: string,
  ): Promise<bigint>;
  /** Native ETH balance used only for settlement-chain network fees. */
  readWalletNativeBalanceWei(
    environment: LighterEnvironment,
    walletAddress: string,
  ): Promise<bigint>;
  /** Whether the wallet holds a swappable asset to acquire more settlement asset. */
  readWalletCanAcquireSettlement(
    environment: LighterEnvironment,
    walletAddress: string,
  ): Promise<boolean>;
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
  /** Live minimum USDC base units Lighter credits for one Core deposit. */
  readMinimumDepositUnits(environment: LighterEnvironment): Promise<bigint>;
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
  readonly walletSettlementAllowanceUnits: string;
  readonly walletNativeBalanceWei: string;
  readonly walletCanAcquireSettlement: boolean;
  readonly accountExists: boolean;
  readonly accountIndex: number | null;
  readonly accountCollateralUnits: string;
  readonly tradingKeyRegistered: boolean;
  readonly requiredCollateralUnits: string;
  readonly minimumDepositUnits: string;
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
  | "below_lighter_deposit_minimum"
  | "insufficient_wallet_settlement_asset";

/**
 * Exact live-balance decision for funding an intended Lighter position.
 *
 * Only Ethereum-mainnet USDC is directly depositable. Other wallet assets are
 * deliberately excluded: spending them would require its own live quote and
 * approval, so their presence must never be treated as proof that a deposit can
 * be prepared.
 */
export interface LighterFundingAssessment {
  readonly settlementAsset: "USDC" | "USDG";
  readonly decision: LighterFundingDecision;
  readonly requiredCollateralUnits: string;
  readonly requiredCollateralDisplay: string;
  readonly lighterCollateralUnits: string;
  readonly lighterCollateralDisplay: string;
  readonly walletSettlementUnits: string;
  readonly walletSettlementDisplay: string;
  readonly combinedSettlementUnits: string;
  readonly combinedSettlementDisplay: string;
  readonly collateralShortfallUnits: string;
  readonly collateralShortfallDisplay: string;
  readonly depositUnits: string | null;
  readonly depositAmountIn: string | null;
  readonly depositDisplay: string | null;
  readonly walletDepositShortfallUnits: string;
  readonly walletDepositShortfallDisplay: string;
  readonly minimumDepositDisplay: string;
}

export function assessLighterFunding(input: {
  readonly environment?: LighterEnvironment;
  readonly walletSettlementUnits: bigint;
  readonly accountCollateralUnits: bigint;
  readonly requiredCollateralUnits: bigint;
  readonly minimumDepositUnits: bigint;
}): LighterFundingAssessment {
  const environment = input.environment ?? "core";
  const settlementAsset = getLighterFundingDeployment(environment).settlementSymbol;
  assertNonNegativeFundingUnits("walletSettlementUnits", input.walletSettlementUnits);
  assertNonNegativeFundingUnits("accountCollateralUnits", input.accountCollateralUnits);
  assertNonNegativeFundingUnits("requiredCollateralUnits", input.requiredCollateralUnits);
  if (input.minimumDepositUnits <= 0n) {
    throw new Error("Lighter funding assessment minimumDepositUnits must be positive.");
  }

  const collateralShortfall = maxUnits(
    input.requiredCollateralUnits - input.accountCollateralUnits,
    0n,
  );
  const belowMinimum = collateralShortfall > 0n
    && collateralShortfall < input.minimumDepositUnits;
  const depositUnits = collateralShortfall === 0n || belowMinimum
    ? null
    : collateralShortfall;
  const walletDepositShortfall = depositUnits === null
    ? 0n
    : maxUnits(depositUnits - input.walletSettlementUnits, 0n);
  const decision: LighterFundingDecision = depositUnits === null
    ? collateralShortfall === 0n
      ? "ready"
      : "below_lighter_deposit_minimum"
    : walletDepositShortfall === 0n
      ? "prepare_deposit"
      : "insufficient_wallet_settlement_asset";

  return {
    settlementAsset,
    decision,
    requiredCollateralUnits: input.requiredCollateralUnits.toString(),
    requiredCollateralDisplay: displaySettlementUnits(input.requiredCollateralUnits, settlementAsset),
    lighterCollateralUnits: input.accountCollateralUnits.toString(),
    lighterCollateralDisplay: displaySettlementUnits(input.accountCollateralUnits, settlementAsset),
    walletSettlementUnits: input.walletSettlementUnits.toString(),
    walletSettlementDisplay: displaySettlementUnits(input.walletSettlementUnits, settlementAsset),
    combinedSettlementUnits: (input.accountCollateralUnits + input.walletSettlementUnits).toString(),
    combinedSettlementDisplay: displaySettlementUnits(
      input.accountCollateralUnits + input.walletSettlementUnits,
      settlementAsset,
    ),
    collateralShortfallUnits: collateralShortfall.toString(),
    collateralShortfallDisplay: displaySettlementUnits(collateralShortfall, settlementAsset),
    depositUnits: depositUnits?.toString() ?? null,
    depositAmountIn: depositUnits === null ? null : formatSettlementUnits(depositUnits),
    depositDisplay: depositUnits === null ? null : displaySettlementUnits(depositUnits, settlementAsset),
    walletDepositShortfallUnits: walletDepositShortfall.toString(),
    walletDepositShortfallDisplay: displaySettlementUnits(walletDepositShortfall, settlementAsset),
    minimumDepositDisplay: displaySettlementUnits(input.minimumDepositUnits, settlementAsset),
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
  const [
    walletSettlementUnits,
    walletSettlementAllowanceUnits,
    walletNativeBalanceWei,
    walletCanAcquireSettlement,
    minimumDepositUnits,
  ] = await Promise.all([
    readers.readWalletSettlementUnits(input.environment, input.walletAddress),
    readers.readWalletSettlementAllowanceUnits(input.environment, input.walletAddress),
    readers.readWalletNativeBalanceWei(input.environment, input.walletAddress),
    readers.readWalletCanAcquireSettlement(input.environment, input.walletAddress),
    readers.readMinimumDepositUnits(input.environment),
  ]);

  const observation = deriveLighterOnboardingObservation({
    environment: input.environment,
    account,
    vexTradingKeyRegistered,
    walletSettlementUnits,
    walletCanAcquireSettlement,
    requiredCollateralUnits: input.requiredCollateralUnits,
    minimumDepositUnits,
  });

  const plan = planLighterOnboarding(observation);
  const fundingAssessment = assessLighterFunding({
    environment: input.environment,
    walletSettlementUnits,
    accountCollateralUnits: observation.accountCollateralUnits,
    requiredCollateralUnits: input.requiredCollateralUnits,
    minimumDepositUnits,
  });

  return {
    environment: input.environment,
    walletAddress: input.walletAddress,
    walletSettlementUnits: walletSettlementUnits.toString(),
    walletSettlementAllowanceUnits: walletSettlementAllowanceUnits.toString(),
    walletNativeBalanceWei: walletNativeBalanceWei.toString(),
    walletCanAcquireSettlement,
    accountExists: observation.accountExists,
    accountIndex: account?.account_index ?? null,
    accountCollateralUnits: observation.accountCollateralUnits.toString(),
    tradingKeyRegistered: observation.tradingKeyRegistered,
    requiredCollateralUnits: input.requiredCollateralUnits.toString(),
    minimumDepositUnits: minimumDepositUnits.toString(),
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

function displaySettlementUnits(units: bigint, asset: "USDC" | "USDG"): string {
  return `${formatSettlementUnits(units)} ${asset}`;
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
