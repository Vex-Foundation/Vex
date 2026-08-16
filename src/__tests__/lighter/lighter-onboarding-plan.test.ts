import { describe, expect, it } from "vitest";

import {
  decimalToBaseUnits,
  planLighterOnboarding,
  type LighterOnboardingObservation,
} from "@tools/lighter/wallet-funding/onboarding-plan.js";

const USDC = (v: string): bigint => decimalToBaseUnits(v, 6);

function observe(overrides: Partial<LighterOnboardingObservation> = {}): LighterOnboardingObservation {
  return {
    environment: "core",
    walletSettlementUnits: USDC("0"),
    walletCanAcquireSettlement: true,
    accountExists: false,
    tradingKeyRegistered: false,
    accountCollateralUnits: USDC("0"),
    requiredCollateralUnits: USDC("11"),
    ...overrides,
  };
}

function legKinds(plan: ReturnType<typeof planLighterOnboarding>): string[] {
  return plan.legs.map((l) => l.kind);
}

describe("planLighterOnboarding", () => {
  it("plans the full zero-to-position path for a brand-new user holding only ETH", () => {
    const plan = planLighterOnboarding(observe());
    expect(legKinds(plan)).toEqual([
      "acquire_settlement_asset",
      "approve_settlement_asset",
      "deposit",
      "register_trading_key",
    ]);
    expect(plan.ready).toBe(false);
    expect(plan.blocked).toBeNull();
    expect(plan.depositUnits).toBe(USDC("11"));
    expect(plan.acquireUnits).toBe(USDC("11"));
  });

  it("skips the acquire leg when the wallet already holds enough USDC", () => {
    const plan = planLighterOnboarding(observe({ walletSettlementUnits: USDC("50") }));
    expect(legKinds(plan)).toEqual([
      "approve_settlement_asset",
      "deposit",
      "register_trading_key",
    ]);
    expect(plan.acquireUnits).toBeNull();
    expect(plan.depositUnits).toBe(USDC("11"));
  });

  it("acquires only the shortfall when the wallet holds partial USDC", () => {
    const plan = planLighterOnboarding(observe({ walletSettlementUnits: USDC("4") }));
    expect(legKinds(plan)[0]).toBe("acquire_settlement_asset");
    expect(plan.acquireUnits).toBe(USDC("7"));
    expect(plan.depositUnits).toBe(USDC("11"));
  });

  it("only needs the trading-key leg when the account already has enough collateral", () => {
    const plan = planLighterOnboarding(
      observe({ accountExists: true, accountCollateralUnits: USDC("20"), tradingKeyRegistered: false }),
    );
    expect(legKinds(plan)).toEqual(["register_trading_key"]);
    expect(plan.depositUnits).toBeNull();
  });

  it("reports ready with no legs when funded and keyed", () => {
    const plan = planLighterOnboarding(
      observe({ accountExists: true, accountCollateralUnits: USDC("20"), tradingKeyRegistered: true }),
    );
    expect(plan.legs).toEqual([]);
    expect(plan.ready).toBe(true);
  });

  it("only tops up the collateral gap, not the whole requirement", () => {
    const plan = planLighterOnboarding(
      observe({
        accountExists: true,
        tradingKeyRegistered: true,
        accountCollateralUnits: USDC("8"),
        requiredCollateralUnits: USDC("11"),
        walletSettlementUnits: USDC("50"),
      }),
    );
    expect(legKinds(plan)).toEqual(["approve_settlement_asset", "deposit"]);
    expect(plan.depositUnits).toBe(USDC("3"));
  });

  it("raises a sub-minimum deposit gap to the venue floor", () => {
    const plan = planLighterOnboarding(
      observe({
        accountExists: true,
        tradingKeyRegistered: true,
        accountCollateralUnits: USDC("10.5"),
        requiredCollateralUnits: USDC("11"),
        walletSettlementUnits: USDC("50"),
      }),
    );
    // gap is 0.5 USDC but the credited minimum is 1 USDC.
    expect(plan.depositUnits).toBe(USDC("1"));
  });

  it("blocks when funding is short and the wallet cannot acquire more", () => {
    const plan = planLighterOnboarding(
      observe({ walletSettlementUnits: USDC("2"), walletCanAcquireSettlement: false }),
    );
    expect(plan.blocked).not.toBeNull();
    expect(plan.legs).toEqual([]);
    expect(plan.ready).toBe(false);
  });

  it("rejects negative observations", () => {
    expect(() => planLighterOnboarding(observe({ accountCollateralUnits: -1n }))).toThrow(
      /non-negative/,
    );
  });
});

describe("decimalToBaseUnits", () => {
  it("converts whole and fractional USDC exactly", () => {
    expect(decimalToBaseUnits("1", 6)).toBe(1_000_000n);
    expect(decimalToBaseUnits("11.52", 6)).toBe(11_520_000n);
    expect(decimalToBaseUnits("0.000001", 6)).toBe(1n);
  });

  it("rejects over-precise or malformed amounts", () => {
    expect(() => decimalToBaseUnits("1.1234567", 6)).toThrow(/settlement decimals/);
    expect(() => decimalToBaseUnits("-1", 6)).toThrow(/non-negative decimal/);
    expect(() => decimalToBaseUnits("abc", 6)).toThrow(/non-negative decimal/);
  });
});
