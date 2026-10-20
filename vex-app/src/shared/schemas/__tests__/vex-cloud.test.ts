/**
 * The `vexCloud` wire contract. Money crosses whole (wei digits with decimals
 * and symbol, micro-USD digits or null), every object is strict, and the
 * signIn input names wallets and nothing else.
 */

import { describe, expect, it } from "vitest";
import {
  vexCloudAccountResultSchema,
  vexCloudAmountSchema,
  vexCloudSignInInputSchema,
} from "../vex-cloud.js";

const WALLET = "0x1111111111111111111111111111111111111111";
const AMOUNT = { wei: "1000000000000000000000", decimals: 18, symbol: "VEX", usdMicroEstimate: "1000000" };

describe("amounts", () => {
  it("accepts raw digits with their unit, and a null estimate", () => {
    expect(vexCloudAmountSchema.parse(AMOUNT)).toEqual(AMOUNT);
    expect(vexCloudAmountSchema.parse({ ...AMOUNT, usdMicroEstimate: null }).usdMicroEstimate).toBeNull();
  });

  it.each([
    ["a float", { ...AMOUNT, wei: "1.5" }],
    ["a number", { ...AMOUNT, wei: 1000 }],
    ["a negative", { ...AMOUNT, wei: "-1" }],
    ["an exponent", { ...AMOUNT, wei: "1e21" }],
    ["other decimals", { ...AMOUNT, decimals: 6 }],
    ["another symbol", { ...AMOUNT, symbol: "USD" }],
    ["a formatted estimate", { ...AMOUNT, usdMicroEstimate: "$1.00" }],
    ["an extra field", { ...AMOUNT, display: "1,000 VEX" }],
  ])("refuses %s", (_name, value) => {
    expect(vexCloudAmountSchema.safeParse(value).success).toBe(false);
  });
});

describe("signIn input", () => {
  it("is the consented wallet list and nothing else", () => {
    expect(vexCloudSignInInputSchema.safeParse({ wallets: [WALLET] }).success).toBe(true);
    expect(vexCloudSignInInputSchema.safeParse({ wallets: [] }).success).toBe(false);
    expect(vexCloudSignInInputSchema.safeParse({ wallets: [WALLET, WALLET, WALLET, WALLET] }).success).toBe(false);
    expect(vexCloudSignInInputSchema.safeParse({ wallets: [WALLET], domain: "evil.example" }).success).toBe(false);
  });
});

describe("account result", () => {
  it("is a closed union of signed out and signed in", () => {
    expect(
      vexCloudAccountResultSchema.safeParse({ state: "signed_out", reason: "session_expired", localWallets: [WALLET] }).success,
    ).toBe(true);
    expect(vexCloudAccountResultSchema.safeParse({ state: "unknown", localWallets: [] }).success).toBe(false);
    expect(
      vexCloudAccountResultSchema.safeParse({ state: "signed_out", reason: "not_signed_in", localWallets: [], token: "x" }).success,
    ).toBe(false);
  });
});
