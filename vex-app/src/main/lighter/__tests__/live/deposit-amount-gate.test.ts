/**
 * The deposit step's refusals, proven deterministically.
 *
 * This file is NOT gated and needs no flag, no vault, no database and no
 * network: the three amount gates and the card-binding check of
 * `deposit.test.ts` are pure decisions over values, so the behaviour that
 * protects the money path is provable on any machine and stays provable in CI.
 *
 * The live run reaches these same functions with a real balance and a real
 * approval card; what a live run cannot do is demonstrate the refusals, because
 * demonstrating them there would mean deliberately typing a wrong amount against
 * the owner's wallet.
 */

import { describe, expect, it } from "vitest";

import {
  assertDepositCardBinding,
  assertDepositWithinWalletBalance,
  DEPOSIT_AMOUNT_ENV,
  LiveHarnessRefusal,
  parseDepositAmount,
  EXPECTED_WALLET_ADDRESS,
} from "./harness.js";

/** RHC settles in USDG with 6 decimals; 1 USDG is the minimum credited deposit. */
const THREE_USDG_UNITS = 3_000_000n;

describe("the live deposit amount gates", () => {
  it("refuses a missing amount and names the variable that supplies it", () => {
    expect(() => parseDepositAmount(undefined)).toThrow(LiveHarnessRefusal);
    expect(() => parseDepositAmount(undefined)).toThrow(DEPOSIT_AMOUNT_ENV);
    expect(() => parseDepositAmount("   ")).toThrow(DEPOSIT_AMOUNT_ENV);
  });

  it("refuses an amount the production decimal parser rejects", () => {
    for (const raw of ["abc", "-1", "1e3", "3.0000001", "1,5"]) {
      expect(() => parseDepositAmount(raw), raw).toThrow(LiveHarnessRefusal);
    }
  });

  it("refuses an amount below the environment's own minimum deposit", () => {
    expect(() => parseDepositAmount("0.5")).toThrow(LiveHarnessRefusal);
    expect(() => parseDepositAmount("0.5")).toThrow(/below the rhc minimum deposit/);
    // The minimum itself is accepted, so the gate is a floor and not an offset.
    expect(parseDepositAmount("1").amountUnits).toBe(1_000_000n);
  });

  it("accepts a valid amount without rounding or resizing it", () => {
    const request = parseDepositAmount(" 3 ");
    expect(request.amountIn).toBe("3");
    expect(request.amountUnits).toBe(THREE_USDG_UNITS);
    expect(request.settlementSymbol).toBe("USDG");
    expect(parseDepositAmount("3.250000").amountUnits).toBe(3_250_000n);
  });

  it("refuses an amount larger than the wallet's live settlement balance", () => {
    const request = parseDepositAmount("3");
    expect(() => assertDepositWithinWalletBalance(request, {
      walletAddress: EXPECTED_WALLET_ADDRESS,
      walletSettlementUnits: THREE_USDG_UNITS - 1n,
    })).toThrow(LiveHarnessRefusal);
    // Exactly the balance is payable; the gate is not a strict inequality.
    expect(() => assertDepositWithinWalletBalance(request, {
      walletAddress: EXPECTED_WALLET_ADDRESS,
      walletSettlementUnits: THREE_USDG_UNITS,
    })).not.toThrow();
  });
});

describe("the deposit approval card binding", () => {
  const request = parseDepositAmount("3");
  const goodCard = {
    toolId: "lighter.deposit",
    environment: "rhc",
    walletAddress: EXPECTED_WALLET_ADDRESS,
    depositTo: EXPECTED_WALLET_ADDRESS,
    beneficiaryAddress: EXPECTED_WALLET_ADDRESS,
    amountUnits: THREE_USDG_UNITS.toString(),
  };

  it("accepts a card that carries the requested amount and destination", () => {
    expect(() => assertDepositCardBinding({
      criticalArgs: goodCard,
      request,
      walletAddress: EXPECTED_WALLET_ADDRESS,
    })).not.toThrow();
  });

  it("refuses a card whose amount is not the requested amount", () => {
    expect(() => assertDepositCardBinding({
      criticalArgs: { ...goodCard, amountUnits: "3000001" },
      request,
      walletAddress: EXPECTED_WALLET_ADDRESS,
    })).toThrow(LiveHarnessRefusal);
  });

  it("refuses a card that credits another address", () => {
    const stranger = "0x000000000000000000000000000000000000dEaD";
    for (const key of ["walletAddress", "depositTo", "beneficiaryAddress"] as const) {
      expect(() => assertDepositCardBinding({
        criticalArgs: { ...goodCard, [key]: stranger },
        request,
        walletAddress: EXPECTED_WALLET_ADDRESS,
      }), key).toThrow(LiveHarnessRefusal);
    }
  });

  it("refuses a card for another environment", () => {
    expect(() => assertDepositCardBinding({
      criticalArgs: { ...goodCard, environment: "core" },
      request,
      walletAddress: EXPECTED_WALLET_ADDRESS,
    })).toThrow(LiveHarnessRefusal);
  });
});
