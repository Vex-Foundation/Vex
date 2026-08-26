/**
 * MANDATORY fee bounds and the forbidden redirect fields.
 *
 * The two rules under test are rule-90 obligations, not conveniences:
 *
 *  - a prepare with no caps REFUSES and hands back the current network numbers
 *    as LABELLED HINTS, so nothing derived becomes an authorization;
 *  - a caller-supplied redirect field is refused BY NAME rather than dropped,
 *    because a caller who passed `from` and saw a success would reasonably
 *    believe it was honoured.
 */

import { describe, it, expect } from "vitest";

import {
  assertQueriedSolanaMessageFee,
  forbiddenRedirectFieldRefusal,
  parseEvmFeeBounds,
  parseSolanaFeeBounds,
  FORBIDDEN_REDIRECT_FIELDS,
  SOLANA_LAMPORTS_PER_SIGNATURE,
  type EvmFeeEstimates,
  type SolanaFeeEstimates,
} from "@vex-agent/tools/internal/wallet/transaction/fee-bounds.js";
import type { SolanaFeeBounds } from "@vex-agent/db/contracts/wallet-transaction-intent.js";

const EVM_ESTIMATES: EvmFeeEstimates = {
  suggestedGasLimit: "21000",
  suggestedMaxFeePerGasWei: "1500000000",
  suggestedMaxPriorityFeePerGasWei: "100000000",
  suggestedGasPriceWei: "1400000000",
  supportsEip1559: true,
};

const SOLANA_ESTIMATES: SolanaFeeEstimates = {
  suggestedComputeUnitLimit: "200000",
  suggestedComputeUnitPriceMicroLamports: "5000",
};

describe("forbidden redirect fields", () => {
  for (const key of FORBIDDEN_REDIRECT_FIELDS.keys()) {
    it(`refuses \`${key}\` BY NAME`, () => {
      const refusal = forbiddenRedirectFieldRefusal({ [key]: "0xdeadbeef" });
      expect(refusal).not.toBeNull();
      expect(refusal?.code).toBe("forbidden_field");
      expect(refusal?.details?.field).toBe(key);
      // The NAME has to be in the sentence, not only in the structured detail:
      // the model reads the sentence.
      expect(refusal?.message).toContain(`\`${key}\``);
    });
  }

  it("passes clean params through", () => {
    expect(forbiddenRedirectFieldRefusal({ to: "0x1", gasLimit: "21000" })).toBeNull();
  });

  it("refuses a redirect field even when its value is empty", () => {
    // Presence is the signal. A caller who sent `from: ""` still believes the
    // sender is theirs to choose.
    expect(forbiddenRedirectFieldRefusal({ from: "" })).not.toBeNull();
  });
});

describe("EVM fee bounds are REQUIRED", () => {
  it("refuses with LABELLED estimates when nothing was supplied", () => {
    const result = parseEvmFeeBounds({}, EVM_ESTIMATES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("missing_fee_bounds");
    expect(result.refusal.message).toContain("HINTS ONLY");
    expect(result.refusal.message).toContain("does not turn a network estimate into a spending limit");
    // Every hint key is prefixed `hint`, so nothing in the refusal can be
    // mistaken for a value that was applied.
    for (const key of Object.keys(result.refusal.details ?? {})) {
      expect(key.startsWith("hint")).toBe(true);
    }
    expect(result.refusal.details?.hintSuggestedGasLimit).toBe("21000");
  });

  it("refuses when the pricing mode is given but the gas limit is not", () => {
    const result = parseEvmFeeBounds({ maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "1" }, EVM_ESTIMATES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("missing_fee_bounds");
  });

  it("computes the EIP-1559 maximum total in integer arithmetic", () => {
    const result = parseEvmFeeBounds(
      {
        gasLimit: "21000",
        maxFeePerGasWei: "123456789012345678901",
        maxPriorityFeePerGasWei: "1",
      },
      EVM_ESTIMATES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A product this size is exact only in bigint; a float would round it.
    expect(result.value.maxTotalFeeWei).toBe((21000n * 123456789012345678901n).toString());
  });

  it("computes the legacy maximum total", () => {
    const result = parseEvmFeeBounds({ gasLimit: "21000", gasPriceWei: "1000000000" }, EVM_ESTIMATES);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toMatchObject({ mode: "legacy", maxTotalFeeWei: "21000000000000" });
  });

  it("refuses BOTH pricing modes at once rather than preferring one", () => {
    const result = parseEvmFeeBounds(
      { gasLimit: "21000", gasPriceWei: "1", maxFeePerGasWei: "2", maxPriorityFeePerGasWei: "1" },
      EVM_ESTIMATES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toContain("exactly one pricing mode");
  });

  it("refuses a priority tip above the max fee", () => {
    const result = parseEvmFeeBounds(
      { gasLimit: "21000", maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "2" },
      EVM_ESTIMATES,
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a zero gas limit", () => {
    const result = parseEvmFeeBounds(
      { gasLimit: "0", maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "1" },
      EVM_ESTIMATES,
    );
    expect(result.ok).toBe(false);
  });

  it("refuses a JSON NUMBER, and says why", () => {
    const result = parseEvmFeeBounds(
      { gasLimit: 21000, maxFeePerGasWei: "1", maxPriorityFeePerGasWei: "1" },
      EVM_ESTIMATES,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("invalid_input");
    expect(result.refusal.message).toContain("2^53");
  });

  it("refuses a human decimal where base units are required", () => {
    const result = parseEvmFeeBounds(
      { gasLimit: "21000", maxFeePerGasWei: "1.5", maxPriorityFeePerGasWei: "1" },
      EVM_ESTIMATES,
    );
    expect(result.ok).toBe(false);
  });
});

describe("Solana fee bounds are REQUIRED", () => {
  it("refuses with labelled estimates and names the per-signature base fee", () => {
    const result = parseSolanaFeeBounds({}, 1, SOLANA_ESTIMATES);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.code).toBe("missing_fee_bounds");
    expect(result.refusal.message).toContain("REQUESTED compute-unit limit");
    expect(result.refusal.details?.hintBaseFeeLamportsPerSignature).toBe(
      SOLANA_LAMPORTS_PER_SIGNATURE.toString(),
    );
  });

  it("derives the priority fee from the REQUESTED limit, rounding UP", () => {
    // 1 CU at 1 micro-lamport is 0.000001 lamports. Rounding down would leave a
    // bound the actual charge exceeds, so the ceiling is taken.
    const result = parseSolanaFeeBounds(
      { computeUnitLimit: "1", computeUnitPriceMicroLamports: "1" },
      1,
      SOLANA_ESTIMATES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxPriorityFeeLamports).toBe("1");
    expect(result.value.baseFeeLamports).toBe("5000");
    expect(result.value.maxTotalFeeLamports).toBe("5001");
  });

  it("prices an exact multiple without adding a rounding lamport", () => {
    const result = parseSolanaFeeBounds(
      { computeUnitLimit: "1000000", computeUnitPriceMicroLamports: "1" },
      1,
      SOLANA_ESTIMATES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.maxPriorityFeeLamports).toBe("1");
  });

  it("charges the base fee per required signature", () => {
    const result = parseSolanaFeeBounds(
      { computeUnitLimit: "1", computeUnitPriceMicroLamports: "0" },
      3,
      SOLANA_ESTIMATES,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.baseFeeLamports).toBe("15000");
  });

  it("refuses a zero compute-unit limit", () => {
    const result = parseSolanaFeeBounds(
      { computeUnitLimit: "0", computeUnitPriceMicroLamports: "1" },
      1,
      SOLANA_ESTIMATES,
    );
    expect(result.ok).toBe(false);
  });
});

describe("assertQueriedSolanaMessageFee - the queried fee IS the authorization basis (V5)", () => {
  const BOUNDS: SolanaFeeBounds = {
    mode: "solana",
    computeUnitLimit: "200000",
    computeUnitPriceMicroLamports: "1000",
    baseFeeLamports: "5000",
    maxPriorityFeeLamports: "200",
    maxTotalFeeLamports: "5200",
  };

  it("accepts a queried fee at or below the authorized total", () => {
    expect(assertQueriedSolanaMessageFee(5200, BOUNDS, "confirm").ok).toBe(true);
    expect(assertQueriedSolanaMessageFee(5000, BOUNDS, "prepare").ok).toBe(true);
  });

  it("refuses when the queried fee EXCEEDS the authorized total", () => {
    const result = assertQueriedSolanaMessageFee(5201, BOUNDS, "confirm");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toContain("5201");
    expect(result.refusal.message).toContain("5200");
    expect(result.refusal.message).toContain("Nothing was signed");
  });

  it("refuses a NULL (unqueryable) fee rather than defaulting to the 5000 constant", () => {
    const result = assertQueriedSolanaMessageFee(null, BOUNDS, "confirm");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.refusal.message).toContain("could not be queried");
  });

  it("refuses a malformed (non-safe-integer) fee value", () => {
    expect(assertQueriedSolanaMessageFee(Number.MAX_SAFE_INTEGER + 2, BOUNDS, "confirm").ok).toBe(false);
    expect(assertQueriedSolanaMessageFee(-1, BOUNDS, "prepare").ok).toBe(false);
  });

  it("keeps the 5000 per-signature value as a HINT floor only, not the basis", () => {
    // The constant still exists for the hint, but it is not what authorizes the
    // fee: a message quoted above the cap is refused even though the constant is
    // unchanged.
    expect(SOLANA_LAMPORTS_PER_SIGNATURE).toBe(5000n);
    expect(assertQueriedSolanaMessageFee(1_000_000, BOUNDS, "confirm").ok).toBe(false);
  });
});
