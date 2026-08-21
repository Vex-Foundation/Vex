/**
 * Execute-time revalidation unit tests (W5 design §6 R4).
 *
 * These pin the TRADE-SHAPE checks a fresh `/build` must still satisfy: exact-
 * input mode, unchanged knobs, unchanged fee destination, unchanged mints and
 * input amount. They deliberately pin NO price comparison: the quote-to-quote
 * floor check (`assertEconomicFloorHolds`) was removed by owner decision
 * (2026-07-25) because `persistedFloor = quotedOut × (1−s)` and
 * `freshFloor = freshOut × (1−s)` made it equivalent to `freshOut >= quotedOut`
 * — a zero tolerance on price movement stacked on top of the caller's own
 * `slippageBps`, which no re-quote on a thin pair could ever satisfy.
 */

import { describe, expect, it } from "vitest";

const {
  assertExactInSwapMode,
  parseAtomicBigint,
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

describe("assertExactInSwapMode", () => {
  it("rejects a fresh swapMode other than ExactIn", () => {
    expect(() => assertExactInSwapMode(buildResp("99", "100", "ExactOut"))).toThrow(VexError);
  });

  it("throws SOLANA_SWAP_FAILED, and says a fresh quote — not a wider tolerance — is the way out", () => {
    try {
      assertExactInSwapMode(buildResp("99", "100", "ExactOut"));
      throw new Error("expected a throw");
    } catch (err) {
      const e = err as InstanceType<typeof VexError>;
      expect(e.code).toBe(ErrorCodes.SOLANA_SWAP_FAILED);
      expect(e.message).toContain("Nothing was signed");
      expect(e.message).toContain("solana__swap_quote");
    }
  });

  it("passes ExactIn, and an absent swapMode (Jupiter's documented default)", () => {
    expect(() => assertExactInSwapMode(buildResp("99", "100", "ExactIn"))).not.toThrow();
    expect(() => assertExactInSwapMode(buildResp("99", "100", undefined))).not.toThrow();
  });

  it("does NOT look at the price: a fresh floor far below the quoted one proceeds", () => {
    // The removed R4b gate blocked exactly this shape (persisted floor 99,
    // fresh outAmount 100, fresh floor 98). Slippage is the price protection
    // now, so a repriced-but-well-formed build must reach the signer.
    expect(() => assertExactInSwapMode(buildResp("1", "100"))).not.toThrow();
  });
});

describe("parseAtomicBigint", () => {
  // Kept from the deleted floor-gate suite: `build-response-guard.ts` consumes
  // this parser for its own response-identity checks, so its "never
  // lexicographic, never coerced" contract still needs pinning.
  it("parses as bigint, not lexicographically ('100' < '99' as strings, 100n > 99n as numbers)", () => {
    expect(parseAtomicBigint("x", "100") > parseAtomicBigint("x", "99")).toBe(true);
  });

  it("rejects a non-numeric atomic amount rather than coercing it", () => {
    expect(() => parseAtomicBigint("fresh.otherAmountThreshold", "not-a-number")).toThrow(VexError);
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
