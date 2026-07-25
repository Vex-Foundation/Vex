import { describe, it, expect } from "vitest";

import {
  filterJupiterTokensByThreshold,
  validateJupiterTokenThresholdFilters,
} from "@tools/solana-ecosystem/jupiter/jupiter-tokens/token-filters.js";
import type { JupiterMintInformation } from "@tools/solana-ecosystem/jupiter/jupiter-tokens/types.js";

function token(overrides: Partial<JupiterMintInformation> = {}): JupiterMintInformation {
  return {
    id: "So11111111111111111111111111111111111111112",
    name: "Wrapped SOL",
    symbol: "SOL",
    decimals: 9,
    ...overrides,
  };
}

describe("validateJupiterTokenThresholdFilters", () => {
  it("accepts absent filters", () => {
    expect(validateJupiterTokenThresholdFilters({})).toBeUndefined();
  });

  it("accepts in-range values (including the 0/100 boundaries)", () => {
    expect(validateJupiterTokenThresholdFilters({ minOrganicScore: 0 })).toBeUndefined();
    expect(validateJupiterTokenThresholdFilters({ minOrganicScore: 100 })).toBeUndefined();
    expect(validateJupiterTokenThresholdFilters({ minLiquidity: 0 })).toBeUndefined();
    expect(validateJupiterTokenThresholdFilters({ verifiedOnly: true })).toBeUndefined();
  });

  it("rejects minOrganicScore out of the 0-100 range (never clamps)", () => {
    expect(validateJupiterTokenThresholdFilters({ minOrganicScore: -1 })).toContain("minOrganicScore");
    expect(validateJupiterTokenThresholdFilters({ minOrganicScore: 101 })).toContain("minOrganicScore");
    expect(validateJupiterTokenThresholdFilters({ minOrganicScore: Number.NaN })).toContain("minOrganicScore");
  });

  it("rejects a negative minLiquidity (never clamps)", () => {
    expect(validateJupiterTokenThresholdFilters({ minLiquidity: -0.01 })).toContain("minLiquidity");
    expect(validateJupiterTokenThresholdFilters({ minLiquidity: Number.POSITIVE_INFINITY })).toContain("minLiquidity");
  });
});

describe("filterJupiterTokensByThreshold", () => {
  it("returns every token unchanged (a fresh copy) when no filters are set", () => {
    const tokens = [token(), token({ id: "Mint2" })];
    const result = filterJupiterTokensByThreshold(tokens, {});
    expect(result).toEqual(tokens);
    expect(result).not.toBe(tokens);
  });

  it("keeps only tokens meeting minOrganicScore, excluding tokens with no organicScore", () => {
    const tokens = [
      token({ id: "High", organicScore: 80 }),
      token({ id: "Low", organicScore: 10 }),
      token({ id: "Unknown" }),
    ];
    const result = filterJupiterTokensByThreshold(tokens, { minOrganicScore: 50 });
    expect(result.map((t) => t.id)).toEqual(["High"]);
  });

  it("keeps only isVerified === true tokens when verifiedOnly is set, excluding null/absent", () => {
    const tokens = [
      token({ id: "Verified", isVerified: true }),
      token({ id: "NotVerified", isVerified: false }),
      token({ id: "NullVerified", isVerified: null }),
      token({ id: "AbsentVerified" }),
    ];
    const result = filterJupiterTokensByThreshold(tokens, { verifiedOnly: true });
    expect(result.map((t) => t.id)).toEqual(["Verified"]);
  });

  it("keeps only tokens meeting minLiquidity, excluding tokens with no liquidity", () => {
    const tokens = [
      token({ id: "Deep", liquidity: 500_000 }),
      token({ id: "Shallow", liquidity: 100 }),
      token({ id: "Unknown" }),
    ];
    const result = filterJupiterTokensByThreshold(tokens, { minLiquidity: 10_000 });
    expect(result.map((t) => t.id)).toEqual(["Deep"]);
  });

  it("applies all three filters together (AND semantics)", () => {
    const tokens = [
      token({ id: "PassesAll", organicScore: 90, isVerified: true, liquidity: 1_000_000 }),
      token({ id: "FailsScore", organicScore: 10, isVerified: true, liquidity: 1_000_000 }),
      token({ id: "FailsVerified", organicScore: 90, isVerified: false, liquidity: 1_000_000 }),
      token({ id: "FailsLiquidity", organicScore: 90, isVerified: true, liquidity: 1 }),
    ];
    const result = filterJupiterTokensByThreshold(tokens, {
      minOrganicScore: 50,
      verifiedOnly: true,
      minLiquidity: 10_000,
    });
    expect(result.map((t) => t.id)).toEqual(["PassesAll"]);
  });

  it("minOrganicScore: 0 keeps a token with organicScore 0 but drops one with no organicScore", () => {
    const tokens = [token({ id: "Zero", organicScore: 0 }), token({ id: "Unknown" })];
    const result = filterJupiterTokensByThreshold(tokens, { minOrganicScore: 0 });
    expect(result.map((t) => t.id)).toEqual(["Zero"]);
  });
});
