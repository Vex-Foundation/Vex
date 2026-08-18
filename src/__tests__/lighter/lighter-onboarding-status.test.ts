import { describe, expect, it, vi } from "vitest";

import {
  resolveLighterOnboardingStatus,
  type LighterOnboardingReaders,
} from "@tools/lighter/wallet-funding/onboarding-status.js";

function readers(overrides: Partial<LighterOnboardingReaders> = {}): LighterOnboardingReaders {
  return {
    readWalletSettlementUnits: vi.fn().mockResolvedValue(0n),
    readWalletCanAcquireSettlement: vi.fn().mockResolvedValue(true),
    readLighterAccount: vi.fn().mockResolvedValue(null),
    readVexTradingKeyRegistered: vi.fn().mockResolvedValue(false),
    readMinimumDepositUnits: vi.fn().mockResolvedValue(1_000_000n),
    ...overrides,
  };
}

describe("resolveLighterOnboardingStatus", () => {
  it("reports the full onboarding plan for a brand-new ETH-only wallet", async () => {
    const status = await resolveLighterOnboardingStatus(readers(), {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 11_000_000n,
    });
    expect(status.accountExists).toBe(false);
    expect(status.accountIndex).toBeNull();
    expect(status.tradingKeyRegistered).toBe(false);
    expect(status.plan.legs.map((l) => l.kind)).toEqual([
      "acquire_settlement_asset",
      "approve_settlement_asset",
      "deposit",
      "register_trading_key",
    ]);
    expect(status.plan.depositUnits).toBe("11000000");
  });

  it("never queries the trading key when no account exists", async () => {
    const r = readers();
    await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 11_000_000n,
    });
    expect(r.readVexTradingKeyRegistered).not.toHaveBeenCalled();
  });

  it("reports ready with no legs for a funded, keyed account", async () => {
    const r = readers({
      readLighterAccount: vi.fn().mockResolvedValue({
        account_index: 736778,
        status: 1,
        available_balance: "20.0",
      }),
      readVexTradingKeyRegistered: vi.fn().mockResolvedValue(true),
      readWalletSettlementUnits: vi.fn().mockResolvedValue(0n),
    });
    const status = await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 11_000_000n,
    });
    expect(status.accountExists).toBe(true);
    expect(status.accountIndex).toBe(736778);
    expect(status.tradingKeyRegistered).toBe(true);
    expect(status.plan.ready).toBe(true);
    expect(status.plan.legs).toEqual([]);
    expect(r.readVexTradingKeyRegistered).toHaveBeenCalledWith("core", 736778);
  });

  it("plans only the key leg when funded but unkeyed", async () => {
    const r = readers({
      readLighterAccount: vi.fn().mockResolvedValue({ account_index: 5, available_balance: "50.0" }),
      readVexTradingKeyRegistered: vi.fn().mockResolvedValue(false),
    });
    const status = await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 11_000_000n,
    });
    expect(status.plan.legs.map((l) => l.kind)).toEqual(["register_trading_key"]);
  });

  it("surfaces a blocked plan when short with no acquirable asset", async () => {
    const r = readers({
      readWalletSettlementUnits: vi.fn().mockResolvedValue(2_000_000n),
      readWalletCanAcquireSettlement: vi.fn().mockResolvedValue(false),
    });
    const status = await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 11_000_000n,
    });
    expect(status.plan.blocked).not.toBeNull();
    expect(status.plan.ready).toBe(false);
  });

  it("prepares only the live collateral shortfall when wallet USDC covers it", async () => {
    const r = readers({
      readWalletSettlementUnits: vi.fn().mockResolvedValue(2_070_000n),
      readLighterAccount: vi.fn().mockResolvedValue({
        account_index: 42,
        available_balance: "1.0",
      }),
      readVexTradingKeyRegistered: vi.fn().mockResolvedValue(true),
    });
    const status = await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 2_000_000n,
    });

    expect(status.fundingAssessment).toEqual(expect.objectContaining({
      decision: "prepare_deposit",
      requiredCollateralDisplay: "2 USDC",
      lighterCollateralDisplay: "1 USDC",
      walletUsdcDisplay: "2.07 USDC",
      combinedUsdcDisplay: "3.07 USDC",
      collateralShortfallDisplay: "1 USDC",
      depositAmountIn: "1",
      depositDisplay: "1 USDC",
      walletDepositShortfallDisplay: "0 USDC",
    }));
  });

  it("does not count ETH as depositable USDC when the wallet cannot cover the top-up", async () => {
    const r = readers({
      readWalletSettlementUnits: vi.fn().mockResolvedValue(250_000n),
      readWalletCanAcquireSettlement: vi.fn().mockResolvedValue(true),
      readLighterAccount: vi.fn().mockResolvedValue({
        account_index: 42,
        available_balance: "1.0",
      }),
      readVexTradingKeyRegistered: vi.fn().mockResolvedValue(true),
    });
    const status = await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 2_000_000n,
    });

    expect(status.walletCanAcquireSettlement).toBe(true);
    expect(status.fundingAssessment).toEqual(expect.objectContaining({
      decision: "insufficient_wallet_usdc",
      lighterCollateralDisplay: "1 USDC",
      walletUsdcDisplay: "0.25 USDC",
      combinedUsdcDisplay: "1.25 USDC",
      depositDisplay: "1 USDC",
      walletDepositShortfallDisplay: "0.75 USDC",
    }));
  });

  it("stops without rounding when the exact top-up is below Lighter's live minimum", async () => {
    const r = readers({
      readWalletSettlementUnits: vi.fn().mockResolvedValue(50_000_000n),
      readLighterAccount: vi.fn().mockResolvedValue({
        account_index: 42,
        available_balance: "1.5",
      }),
      readVexTradingKeyRegistered: vi.fn().mockResolvedValue(true),
    });
    const status = await resolveLighterOnboardingStatus(r, {
      environment: "core",
      walletAddress: "0xabc",
      requiredCollateralUnits: 2_000_000n,
    });

    expect(status.fundingAssessment).toEqual(expect.objectContaining({
      decision: "below_lighter_deposit_minimum",
      requiredCollateralDisplay: "2 USDC",
      lighterCollateralDisplay: "1.5 USDC",
      walletUsdcDisplay: "50 USDC",
      combinedUsdcDisplay: "51.5 USDC",
      collateralShortfallDisplay: "0.5 USDC",
      minimumDepositDisplay: "1 USDC",
      depositAmountIn: null,
      depositDisplay: null,
      walletDepositShortfallDisplay: "0 USDC",
    }));
    expect(status.plan).toMatchObject({
      ready: false,
      depositUnits: null,
      legs: [],
    });
    expect(status.plan.blocked).toContain("below Lighter's live minimum deposit");
  });
});
