/**
 * Pure state-driven planner for Lighter wallet-funded account onboarding.
 *
 * Given a read-only observation of the user's Vex wallet and their Lighter
 * account, it computes the MINIMAL ordered set of legs needed to reach "able to
 * open the intended position". Every leg is included only if state requires it,
 * so a re-run after a partial failure re-computes the delta and resumes. This
 * module performs no I/O, holds no keys, and moves no funds — it only decides
 * what must happen. Execution of each leg is gated separately (M-C..M-F).
 *
 * See `.context/lighter_wallet_funding_plan.md`.
 */

import type { LighterEnvironment } from "../constants.js";
import { LIGHTER_DEPOSIT_MIN_USDC, LIGHTER_SETTLEMENT_ASSET_DECIMALS } from "./constants.js";

/** Ordered kinds of onboarding leg. Ordering here is execution order. */
export const LIGHTER_ONBOARDING_LEG_KINDS = [
  "acquire_settlement_asset",
  "approve_settlement_asset",
  "deposit",
  "register_trading_key",
] as const;

export type LighterOnboardingLegKind = (typeof LIGHTER_ONBOARDING_LEG_KINDS)[number];

/**
 * Read-only observation feeding the planner. All settlement-asset amounts are
 * integer base units at 6-decimal USDC scale (bigint), never floats.
 */
export interface LighterOnboardingObservation {
  readonly environment: LighterEnvironment;
  /** Settlement asset (USDC) the Vex wallet already holds on the deposit chain. */
  readonly walletSettlementUnits: bigint;
  /**
   * Can the wallet obtain more settlement asset if short (e.g. it holds a
   * swappable asset such as native ETH with a route to USDC)? When false and a
   * shortfall exists, the plan is blocked rather than assuming a swap.
   */
  readonly walletCanAcquireSettlement: boolean;
  /** Does the Vex wallet's L1 address already own a Lighter account? */
  readonly accountExists: boolean;
  /** Is a Vex-controlled trading key already registered on that account? */
  readonly tradingKeyRegistered: boolean;
  /** Settlement collateral already credited inside the Lighter account. */
  readonly accountCollateralUnits: bigint;
  /** Settlement collateral the intended position requires. */
  readonly requiredCollateralUnits: bigint;
}

export interface LighterOnboardingLeg {
  readonly kind: LighterOnboardingLegKind;
  readonly reason: string;
}

export interface LighterOnboardingPlan {
  readonly environment: LighterEnvironment;
  /** Legs in execution order; empty when the user can already open the position. */
  readonly legs: readonly LighterOnboardingLeg[];
  /** True when no legs are required (account funded + keyed for the position). */
  readonly ready: boolean;
  /** Non-null reason when onboarding cannot proceed from current state. */
  readonly blocked: string | null;
  /** Settlement units the deposit leg must credit, when a deposit is required. */
  readonly depositUnits: bigint | null;
  /** Settlement units the acquire leg must obtain, when acquisition is required. */
  readonly acquireUnits: bigint | null;
}

const LIGHTER_DEPOSIT_MIN_UNITS = decimalToBaseUnits(
  LIGHTER_DEPOSIT_MIN_USDC,
  LIGHTER_SETTLEMENT_ASSET_DECIMALS,
);

/**
 * Compute the minimal onboarding leg plan. Deterministic and side-effect free.
 */
export function planLighterOnboarding(
  observation: LighterOnboardingObservation,
): LighterOnboardingPlan {
  assertNonNegative("walletSettlementUnits", observation.walletSettlementUnits);
  assertNonNegative("accountCollateralUnits", observation.accountCollateralUnits);
  assertNonNegative("requiredCollateralUnits", observation.requiredCollateralUnits);

  const legs: LighterOnboardingLeg[] = [];
  let depositUnits: bigint | null = null;
  let acquireUnits: bigint | null = null;

  // 1. Collateral gap. Only fund what the position is actually short.
  const collateralGap = observation.requiredCollateralUnits - observation.accountCollateralUnits;

  if (collateralGap > 0n) {
    // A deposit is needed. It never credits below the venue floor, so a small
    // gap is raised to the minimum credited deposit.
    depositUnits = collateralGap < LIGHTER_DEPOSIT_MIN_UNITS ? LIGHTER_DEPOSIT_MIN_UNITS : collateralGap;

    // The wallet must hold enough settlement asset to deposit it. Acquire only
    // the shortfall, and only if the wallet has a route to more.
    const settlementShortfall = depositUnits - observation.walletSettlementUnits;
    if (settlementShortfall > 0n) {
      if (!observation.walletCanAcquireSettlement) {
        return blockedPlan(
          observation.environment,
          `Wallet holds insufficient settlement asset to fund the position and has no asset to acquire more: short ${settlementShortfall} base units.`,
        );
      }
      acquireUnits = settlementShortfall;
      legs.push({
        kind: "acquire_settlement_asset",
        reason: `Acquire ${settlementShortfall} settlement base units to cover the deposit shortfall.`,
      });
    }

    // ERC-20 approval always precedes a deposit debit; allowance reuse is an
    // execution-time optimization, not a planning concern.
    legs.push({
      kind: "approve_settlement_asset",
      reason: "Authorize the Lighter deposit contract to pull the settlement asset.",
    });
    legs.push({
      kind: "deposit",
      reason: observation.accountExists
        ? `Deposit ${depositUnits} settlement base units to top up account collateral.`
        : `Deposit ${depositUnits} settlement base units; the first deposit creates the Vex-owned account.`,
    });
  }

  // 2. Trading key. Needed whenever no Vex-controlled key is registered. After a
  //    first-ever deposit the account is brand new, so this is the common path.
  if (!observation.tradingKeyRegistered) {
    legs.push({
      kind: "register_trading_key",
      reason: observation.accountExists || collateralGap > 0n
        ? "Register a Vex trading key on the account via L2ChangePubKey before any order can be signed."
        : "No Lighter account or trading key exists yet; onboarding must create and key the account.",
    });
  }

  // An account with no collateral gap but also no key still needs the key; an
  // account that exists only after a pending deposit is handled above.
  return {
    environment: observation.environment,
    legs,
    ready: legs.length === 0,
    blocked: null,
    depositUnits,
    acquireUnits,
  };
}

function blockedPlan(environment: LighterEnvironment, reason: string): LighterOnboardingPlan {
  return {
    environment,
    legs: [],
    ready: false,
    blocked: reason,
    depositUnits: null,
    acquireUnits: null,
  };
}

function assertNonNegative(field: string, value: bigint): void {
  if (value < 0n) {
    throw new Error(`Lighter onboarding observation ${field} must be non-negative, got ${value}.`);
  }
}

/** Convert a non-negative decimal string to integer base units. Exact, no float. */
export function decimalToBaseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Amount must be a non-negative decimal string, got ${value}.`);
  }
  const [whole, fraction = ""] = value.split(".");
  if (fraction.length > decimals) {
    throw new Error(`Amount ${value} exceeds ${decimals} settlement decimals.`);
  }
  const padded = fraction.padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(padded || "0");
}
