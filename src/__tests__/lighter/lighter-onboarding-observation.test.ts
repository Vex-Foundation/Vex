import { describe, expect, it } from "vitest";

import {
  deriveLighterOnboardingObservation,
  parseSettlementFloor,
  type DeriveOnboardingObservationInput,
} from "@tools/lighter/wallet-funding/onboarding-observation.js";
import { planLighterOnboarding } from "@tools/lighter/wallet-funding/onboarding-plan.js";

function input(overrides: Partial<DeriveOnboardingObservationInput> = {}): DeriveOnboardingObservationInput {
  return {
    environment: "core",
    account: null,
    vexTradingKeyRegistered: false,
    walletSettlementUnits: 0n,
    walletCanAcquireSettlement: true,
    requiredCollateralUnits: 11_000_000n,
    minimumDepositUnits: 1_000_000n,
    ...overrides,
  };
}

describe("deriveLighterOnboardingObservation", () => {
  it("treats a missing account as no account, no collateral, no key", () => {
    const obs = deriveLighterOnboardingObservation(input());
    expect(obs.accountExists).toBe(false);
    expect(obs.accountCollateralUnits).toBe(0n);
    expect(obs.tradingKeyRegistered).toBe(false);
  });

  it("reads free collateral from available_balance of a live-shaped account", () => {
    const obs = deriveLighterOnboardingObservation(
      input({
        account: { account_index: 736778, status: 1, collateral: "14.661381", available_balance: "14.065005" },
        vexTradingKeyRegistered: true,
      }),
    );
    expect(obs.accountExists).toBe(true);
    // available_balance, not collateral.
    expect(obs.accountCollateralUnits).toBe(14_065_005n);
    expect(obs.tradingKeyRegistered).toBe(true);
  });

  it("never reports a registered key when no account exists", () => {
    const obs = deriveLighterOnboardingObservation(input({ account: null, vexTradingKeyRegistered: true }));
    expect(obs.tradingKeyRegistered).toBe(false);
  });

  it("falls back to collateral when available_balance is absent", () => {
    const obs = deriveLighterOnboardingObservation(
      input({ account: { account_index: 1, collateral: "5.0" } }),
    );
    expect(obs.accountCollateralUnits).toBe(5_000_000n);
  });

  it("feeds a plan end-to-end: funded + keyed account is ready", () => {
    const obs = deriveLighterOnboardingObservation(
      input({
        account: { account_index: 1, status: 1, available_balance: "20.0" },
        vexTradingKeyRegistered: true,
        requiredCollateralUnits: 11_000_000n,
      }),
    );
    expect(planLighterOnboarding(obs).ready).toBe(true);
  });
});

describe("parseSettlementFloor", () => {
  it("parses exact 6-decimal USDC", () => {
    expect(parseSettlementFloor("14.065005")).toBe(14_065_005n);
    expect(parseSettlementFloor("0")).toBe(0n);
  });

  it("floors extra precision rather than rejecting it", () => {
    expect(parseSettlementFloor("1.1234567")).toBe(1_123_456n);
  });

  it("rejects negative or non-numeric input", () => {
    expect(() => parseSettlementFloor("-1")).toThrow(/non-negative/);
    expect(() => parseSettlementFloor("x")).toThrow(/non-negative/);
  });
});
