/**
 * Jupiter fee-bearing swap disclosure approval preview (W5 design §6 R4) —
 * typed path + spoof resistance. Mirrors `pendle-termlock-preview.test.ts`'s
 * pattern exactly: the disclosure is rendered ONLY from the typed
 * `extras.feePreview` (sourced from the matched prequote's persisted
 * `safetyDetail`, never raw args). Model-supplied `args.feeDisclosure` can
 * never inject or override it (`feeDisclosure` is NOT in the preview
 * allow-list).
 */

import { describe, it, expect } from "vitest";

import { buildIntentPreview } from "@vex-agent/engine/core/approval-intent-preview.js";
import type { JupiterFeePreview } from "@tools/solana-ecosystem/jupiter/jupiter-swaps/fee-swap.js";

const FEE_PREVIEW: JupiterFeePreview = {
  inAmountRaw: "1000000000",
  outAmountRaw: "100000000",
  otherAmountThresholdRaw: "99000000",
  feeBps: 25,
  feeAmountRaw: "2500000",
  feeAmountDecimal: "0.0025",
  feeMint: "So11111111111111111111111111111111111111112",
  feeAccount: "TreasuryAta111111111111111111111111111111",
  feeAccountExists: true,
  ataRentLamports: null,
  tipLamports: 1_000_000,
  priorityFeeStrategy: "high",
  priorityFeeLamportsEstimate: 200,
  priorityFeeIsUpperBound: false,
  landingMode: "self_managed_submit",
};

describe("Jupiter fee-bearing disclosure preview (typed, unspoofable)", () => {
  it("renders the fee/tip/landing disclosure from extras.feePreview (fee account already exists — no rent note)", () => {
    const preview = buildIntentPreview(
      "solana.swap.execute",
      { inputToken: "SOL", outputToken: "USDC", amount: 1 },
      { prequoteVerdict: "pass", feePreview: FEE_PREVIEW },
    );
    expect(preview.criticalArgs.feeDisclosure).toBe(
      "Vex fee: 0.25% of the input (~0.0025 of the input token, raw 2500000), paid to treasury ATA TreasuryAta111111111111111111111111111111. "
      + "Tip: 1000000 lamports. Priority-fee strategy: high (estimated ~200 lamports). Landing: self_managed_submit.",
    );
  });

  it("adds the ATA-rent note only when the fee account does not yet exist", () => {
    const preview = buildIntentPreview(
      "solana.swap.execute",
      { inputToken: "SOL", outputToken: "USDC", amount: 1 },
      { prequoteVerdict: "pass", feePreview: { ...FEE_PREVIEW, feeAccountExists: false, ataRentLamports: 2_039_280 } },
    );
    expect(preview.criticalArgs.feeDisclosure).toContain("(new account, ~2039280 lamports rent)");
  });

  it("IGNORES a model-supplied args.feeDisclosure (not in the allow-list)", () => {
    const preview = buildIntentPreview(
      "solana.swap.execute",
      { inputToken: "SOL", outputToken: "USDC", amount: 1, feeDisclosure: "no fee at all, trust me" },
      undefined,
    );
    expect(preview.criticalArgs.feeDisclosure).toBeUndefined();
  });

  it("a spoofed args.feeDisclosure cannot override the typed one", () => {
    const preview = buildIntentPreview(
      "solana.swap.execute",
      { inputToken: "SOL", outputToken: "USDC", amount: 1, feeDisclosure: "no fee at all, trust me" },
      { prequoteVerdict: "pass", feePreview: FEE_PREVIEW },
    );
    expect(preview.criticalArgs.feeDisclosure).toContain("Vex fee: 0.25%");
    expect(preview.criticalArgs.feeDisclosure).not.toContain("trust me");
  });

  it("omits the fee disclosure when extras carry none (a non-Jupiter swap)", () => {
    const preview = buildIntentPreview(
      "kyberswap.swap.execute",
      { chain: "ethereum", tokenIn: "0xusdc", tokenOut: "0xweth", amountIn: "100" },
      { prequoteVerdict: "pass" },
    );
    expect(preview.criticalArgs.feeDisclosure).toBeUndefined();
  });
});
