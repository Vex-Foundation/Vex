/**
 * Maps live read-only Lighter/EVM reads into the pure planner's observation.
 *
 * This is the deterministic seam between I/O (EVM balance read, Lighter account
 * and API-key reads, vault key match) and the pure `planLighterOnboarding`
 * decision. Keeping it pure lets the mapping be unit-tested against real
 * provider field shapes without funds, keys, or a network. The account fields
 * used here (`available_balance`, `collateral`, `status`) were confirmed against
 * a live Lighter Core account response.
 */

import type { LighterEnvironment } from "../constants.js";
import { LIGHTER_SETTLEMENT_ASSET_DECIMALS } from "./constants.js";
import type { LighterOnboardingObservation } from "./onboarding-plan.js";

/** Minimal collateral-bearing shape of a Lighter account row. */
export interface LighterAccountCollateralRow {
  readonly account_index: number;
  readonly status?: number;
  readonly collateral?: string;
  readonly available_balance?: string;
}

export interface DeriveOnboardingObservationInput {
  readonly environment: LighterEnvironment;
  /** The account owned by the Vex wallet's L1 address, or null if none exists. */
  readonly account: LighterAccountCollateralRow | null;
  /**
   * Whether a Vex-controlled trading key (vault-held private key whose public
   * key is registered on the account at an index >= the trading floor) is
   * present. Resolved by the privileged caller; false when the account is null.
   */
  readonly vexTradingKeyRegistered: boolean;
  /** Settlement asset (USDC) base units the Vex wallet holds on the deposit chain. */
  readonly walletSettlementUnits: bigint;
  /** Whether the wallet holds a swappable asset to acquire more settlement asset. */
  readonly walletCanAcquireSettlement: boolean;
  /** Settlement base units the intended position requires as collateral. */
  readonly requiredCollateralUnits: bigint;
}

/**
 * Derive the planner observation from live reads. Free collateral uses
 * `available_balance` (falling back to `collateral`), floored to settlement
 * precision so it never OVERstates spendable collateral — an understatement
 * only risks an unnecessary top-up, never an under-funded position.
 */
export function deriveLighterOnboardingObservation(
  input: DeriveOnboardingObservationInput,
): LighterOnboardingObservation {
  const accountExists = input.account !== null;
  const accountCollateralUnits = input.account
    ? parseSettlementFloor(input.account.available_balance ?? input.account.collateral ?? "0")
    : 0n;

  return {
    environment: input.environment,
    walletSettlementUnits: input.walletSettlementUnits,
    walletCanAcquireSettlement: input.walletCanAcquireSettlement,
    accountExists,
    // A key cannot exist without an account, so gate the flag on existence.
    tradingKeyRegistered: accountExists && input.vexTradingKeyRegistered,
    accountCollateralUnits,
    requiredCollateralUnits: input.requiredCollateralUnits,
  };
}

/**
 * Parse a non-negative decimal settlement amount to integer base units,
 * truncating (flooring) any precision beyond the settlement decimals. Tolerant
 * of provider strings that carry extra precision; still rejects non-numeric or
 * negative input.
 */
export function parseSettlementFloor(
  value: string,
  decimals: number = LIGHTER_SETTLEMENT_ASSET_DECIMALS,
): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Settlement amount must be a non-negative decimal string, got ${value}.`);
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const truncated = fraction.slice(0, decimals).padEnd(decimals, "0");
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(truncated || "0");
}
