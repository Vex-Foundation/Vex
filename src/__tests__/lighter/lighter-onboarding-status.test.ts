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
});
