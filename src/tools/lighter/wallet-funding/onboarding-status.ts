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
  readonly plan: {
    readonly legs: readonly { readonly kind: string; readonly reason: string }[];
    readonly ready: boolean;
    readonly blocked: string | null;
    readonly depositUnits: string | null;
    readonly acquireUnits: string | null;
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
    plan: projectPlan(plan),
  };
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
