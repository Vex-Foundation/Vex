import { describe, expect, it } from "vitest";
import type { LighterAccountSetupStatus } from "@shared/schemas/lighter-trading.js";
import { lighterSetupPresentation } from "../LighterAccountSetupModal.js";

function status(
  overrides: Partial<LighterAccountSetupStatus> = {},
): LighterAccountSetupStatus {
  return {
    environment: "rhc",
    settlementSymbol: "USDG",
    walletSettlementBalance: "0",
    nativeGasSufficient: true,
    minimumDeposit: "1",
    accountExists: false,
    accountCollateral: "0",
    tradingKeyRegistered: false,
    keyRegistrationResumable: false,
    feePolicy: { perpFeePercent: 0.1, spotFeePercent: 0.25 },
    feeAuthorized: false,
    ...overrides,
  };
}

describe("lighterSetupPresentation", () => {
  it("reports every observed idle step instead of resetting key and fee to upcoming", () => {
    expect(lighterSetupPresentation("idle", status()).steps).toEqual([
      "upcoming",
      "upcoming",
      "upcoming",
    ]);

    const depositOnly = lighterSetupPresentation("idle", status({ accountExists: true }));
    expect(depositOnly.steps).toEqual(["done", "upcoming", "upcoming"]);
    expect(depositOnly.statusLabel).toBe(
      "Deposit confirmed. Trading key and fee authorization remain.",
    );
    expect(depositOnly.accountNote).toContain("continues from the trading key");

    const keyReady = lighterSetupPresentation("idle", status({
      accountExists: true,
      tradingKeyRegistered: true,
    }));
    expect(keyReady.steps).toEqual(["done", "done", "upcoming"]);
    expect(keyReady.statusLabel).toBe(
      "Deposit and trading key confirmed. Fee authorization remains.",
    );
    expect(keyReady.accountNote).toContain("continues from fee authorization");
  });

  it("reports a fully configured environment as ready", () => {
    const ready = lighterSetupPresentation("idle", status({
      accountExists: true,
      tradingKeyRegistered: true,
      feeAuthorized: true,
    }));

    expect(ready).toEqual({
      steps: ["done", "done", "done"],
      accountNote: "This wallet is fully set up for Lighter on Robinhood Chain.",
      statusLabel: "Deposit, trading key and fee authorization confirmed.",
      ready: true,
    });
  });

  it("keeps the active operation authoritative while setup is running", () => {
    const observed = status({
      accountExists: true,
      tradingKeyRegistered: true,
      feeAuthorized: true,
    });

    expect(lighterSetupPresentation("registering_key", observed)).toMatchObject({
      steps: ["done", "active", "upcoming"],
      statusLabel: "Registering your trading key…",
      ready: false,
    });
    expect(lighterSetupPresentation("confirming_fee", observed)).toMatchObject({
      steps: ["done", "done", "active"],
      statusLabel: "Confirming fee authorization…",
      ready: false,
    });
  });

  it("uses the selected environment in the account summary", () => {
    const core = lighterSetupPresentation("idle", status({
      environment: "core",
      settlementSymbol: "USDC",
      accountExists: true,
      tradingKeyRegistered: true,
    }));

    expect(core.accountNote).toBe(
      "This wallet's Lighter account and trading key are ready on Core. Setup continues from fee authorization.",
    );
  });
});
