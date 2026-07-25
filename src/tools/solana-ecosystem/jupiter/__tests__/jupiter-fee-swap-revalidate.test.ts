/**
 * Execute-time revalidation unit tests (W5 design §6 R4/R4b). Pins the
 * pinned regression: persisted floor 99, fresh outAmount 100, fresh floor 98
 * → BLOCK before signing (a "better-looking" outAmount must never mask a
 * weakened on-chain floor).
 */

import { describe, expect, it } from "vitest";

const {
  assertEconomicFloorHolds,
  assertKnobsUnchanged,
  assertFeePolicyUnchanged,
  assertMintsAndAmountUnchanged,
} = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap-revalidate.js");
const { resolveJupiterFeeSwapKnobs } = await import("@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js");
const { VexError, ErrorCodes } = await import("../../../../errors.js");

function buildResp(otherAmountThreshold: string, outAmount = "100", swapMode: string | undefined = "ExactIn") {
  return {
    inputMint: "in", outputMint: "out", inAmount: "100", outAmount,
    otherAmountThreshold, swapMode,
    routePlan: [], computeBudgetInstructions: [], setupInstructions: [],
    swapInstruction: { programId: "p", accounts: [], data: "" },
    cleanupInstruction: null, otherInstructions: [],
  };
}

describe("assertEconomicFloorHolds", () => {
  it("pinned regression: persisted floor 99, fresh outAmount 100, fresh floor 98 -> BLOCK", () => {
    expect(() => assertEconomicFloorHolds(buildResp("98", "100"), "99")).toThrow(VexError);
  });

  it("allows a fresh floor equal to the persisted floor", () => {
    expect(() => assertEconomicFloorHolds(buildResp("99"), "99")).not.toThrow();
  });

  it("allows a fresh floor strictly above the persisted floor", () => {
    expect(() => assertEconomicFloorHolds(buildResp("150"), "99")).not.toThrow();
  });

  it("compares as bigint, not lexicographically (100 > 99 despite '100' < '99' as strings, and '9' < '10' numerically must still hold)", () => {
    // Lexicographic string compare would say "100" < "99" (since '1' < '9'),
    // which would wrongly BLOCK a genuinely-higher floor. Bigint compare must
    // not make this mistake.
    expect(() => assertEconomicFloorHolds(buildResp("100"), "99")).not.toThrow();
  });

  it("rejects a non-numeric otherAmountThreshold rather than coercing", () => {
    expect(() => assertEconomicFloorHolds(buildResp("not-a-number"), "99")).toThrow(VexError);
  });

  it("rejects a fresh swapMode other than ExactIn", () => {
    expect(() => assertEconomicFloorHolds(buildResp("99", "100", "ExactOut"), "99")).toThrow(VexError);
  });

  it("throws SOLANA_SWAP_FAILED on violation", () => {
    try {
      assertEconomicFloorHolds(buildResp("98"), "99");
      throw new Error("expected a throw");
    } catch (err) {
      expect((err as InstanceType<typeof VexError>).code).toBe(ErrorCodes.SOLANA_SWAP_FAILED);
    }
  });
});

describe("assertKnobsUnchanged", () => {
  it("passes when every knob is identical", () => {
    const knobs = resolveJupiterFeeSwapKnobs({ dexes: "Raydium", maxAccounts: 40, forJitoBundle: true });
    expect(() => assertKnobsUnchanged(knobs, { ...knobs })).not.toThrow();
  });

  it("blocks on a diverging dexes/excludeDexes/maxAccounts/wrap/forJitoBundle/tip/CU strategy", () => {
    const persisted = resolveJupiterFeeSwapKnobs({});
    expect(() => assertKnobsUnchanged(persisted, resolveJupiterFeeSwapKnobs({ dexes: "Raydium" }))).toThrow(VexError);
    expect(() => assertKnobsUnchanged(persisted, resolveJupiterFeeSwapKnobs({ maxAccounts: 20 }))).toThrow(VexError);
    expect(() => assertKnobsUnchanged(persisted, resolveJupiterFeeSwapKnobs({ wrapAndUnwrapSol: false }))).toThrow(VexError);
    expect(() => assertKnobsUnchanged(persisted, resolveJupiterFeeSwapKnobs({ forJitoBundle: true }))).toThrow(VexError);
    expect(() => assertKnobsUnchanged(persisted, resolveJupiterFeeSwapKnobs({ tipLamports: 2_000_000 }))).toThrow(VexError);
    expect(() => assertKnobsUnchanged(persisted, resolveJupiterFeeSwapKnobs({ computeUnitPricePercentile: "veryHigh" }))).toThrow(VexError);
  });
});

describe("assertFeePolicyUnchanged", () => {
  it("blocks when the fresh fee mint/account diverges from the persisted preview", () => {
    const persisted = {
      inAmountRaw: "1", outAmountRaw: "2", otherAmountThresholdRaw: "2", feeBps: 25,
      feeAmountRaw: "0", feeAmountDecimal: "0",
      feeMint: "mintA", feeAccount: "ataA", feeAccountExists: true, ataRentLamports: null,
      tipLamports: 1_000_000, priorityFeeStrategy: "high", priorityFeeLamportsEstimate: 0,
      priorityFeeIsUpperBound: false,
      landingMode: "self_managed_submit" as const,
    };
    expect(() => assertFeePolicyUnchanged(persisted, "mintA", "ataA")).not.toThrow();
    expect(() => assertFeePolicyUnchanged(persisted, "mintB", "ataA")).toThrow(VexError);
    expect(() => assertFeePolicyUnchanged(persisted, "mintA", "ataB")).toThrow(VexError);
  });
});

describe("assertMintsAndAmountUnchanged", () => {
  it("blocks on any divergence in inputMint/outputMint/amountRaw", () => {
    const persisted = { inputMint: "in", outputMint: "out", amountRaw: "100" };
    expect(() => assertMintsAndAmountUnchanged(persisted, { ...persisted })).not.toThrow();
    expect(() => assertMintsAndAmountUnchanged(persisted, { ...persisted, inputMint: "other" })).toThrow(VexError);
    expect(() => assertMintsAndAmountUnchanged(persisted, { ...persisted, amountRaw: "200" })).toThrow(VexError);
  });
});
