/**
 * Tests for the Jupiter Lend Earn "rates" concise projector (W1-I) —
 * basis-point → exact percent string conversion (string math only, no
 * `parseFloat`), the labeled raw `*Bps` siblings, the asset id-list filter,
 * and the Vex-side rate thresholds. No test here asserts a default cap:
 * every narrowing is via an explicit filter argument.
 *
 * Numeric fixtures below (id/rates/TVL) are taken from the live-recorded
 * shape in agents_dm/agentscan-phase3/fixtures/lend-earn-tokens.json
 * (2026-07-23 `GET /earn/tokens`) rather than invented, per the batch's
 * "fixtures are unit-test ground truth" rule — inlined here (not imported
 * from the gitignored agents_dm/ path) the same way the sibling
 * solana-jupiter-projectors.test.ts inlines its token fixtures.
 */
import { describe, it, expect } from "vitest";

import {
  projectJupiterLendRates,
  type ConciseJupiterLendRate,
} from "@vex-agent/tools/protocols/solana-jupiter/lend-projector.js";
import type { JupiterLendEarnTokenInfo } from "@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/types.js";

/** Real live USDC Earn market row (`id: 2`) — the default fixture for most cases. */
function makeUsdcToken(overrides: Partial<JupiterLendEarnTokenInfo> = {}): JupiterLendEarnTokenInfo {
  return {
    id: 2,
    address: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
    name: "jupiter  lend USDC",
    symbol: "jlUSDC",
    decimals: 6,
    assetAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    asset: {
      address: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      chain_id: "solana",
      name: "USD Coin",
      symbol: "USDC",
      decimals: 6,
      logo_url: "https://coin-images.coingecko.com/coins/images/6319/large/USDC.png",
      price: "0.999875316937",
      coingecko_id: "usd-coin",
    },
    totalAssets: "443980733216176",
    totalSupply: "421800759223650",
    convertToShares: "950043",
    convertToAssets: "1052584",
    rewardsRate: "68",
    supplyRate: "329",
    totalRate: "397",
    rebalanceDifference: "-13893054486962",
    liquiditySupplyData: {
      modeWithInterest: true,
      supply: "442880246538952",
      withdrawalLimit: "221440123269476",
      lastUpdateTimestamp: "1784829221",
      expandPercent: "5000",
      expandDuration: "21600",
      baseWithdrawalLimit: "8270837109656",
      withdrawableUntilLimit: "221440123269476",
      withdrawable: "74276105859976",
    },
    ...overrides,
  };
}

/** Real live WSOL Earn market row (`id: 3`) — zero rewards, 9-decimal underlying asset. */
function makeWsolToken(overrides: Partial<JupiterLendEarnTokenInfo> = {}): JupiterLendEarnTokenInfo {
  return {
    id: 3,
    address: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU",
    name: "jupiter  lend WSOL",
    symbol: "jlWSOL",
    decimals: 9,
    assetAddress: "So11111111111111111111111111111111111111112",
    asset: {
      address: "So11111111111111111111111111111111111111112",
      chain_id: "solana",
      name: "Wrapped SOL",
      symbol: "WSOL",
      decimals: 9,
      logo_url: "https://coin-images.coingecko.com/coins/images/21629/large/solana.jpg",
      price: "75.871974793692",
      coingecko_id: "wrapped-solana",
    },
    totalAssets: "218846527145818",
    totalSupply: "210843691592446",
    convertToShares: "963431745",
    convertToAssets: "1037956249",
    rewardsRate: "0",
    supplyRate: "389",
    totalRate: "389",
    rebalanceDifference: "-8311387528020",
    liquiditySupplyData: {
      modeWithInterest: true,
      supply: "218851120089967",
      withdrawalLimit: "164138340067476",
      lastUpdateTimestamp: "1784828357",
      expandPercent: "2500",
      expandDuration: "21600",
      baseWithdrawalLimit: "46292904785127",
      withdrawableUntilLimit: "54712780022491",
      withdrawable: "54712780022491",
    },
    ...overrides,
  };
}

function ratesById(rows: readonly ConciseJupiterLendRate[], id: string): ConciseJupiterLendRate {
  const found = rows.find((r) => r.id === id);
  if (!found) throw new Error(`expected a row with id ${id}`);
  return found;
}

describe("projectJupiterLendRates — percent formatting (string math only)", () => {
  it("converts 1e4-scaled basis points to an exact percent string via decimal-point shift", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken()]);
    expect(row!.supplyRate).toBe("3.29%");
    expect(row!.rewardsRate).toBe("0.68%");
    expect(row!.totalRate).toBe("3.97%");
  });

  it("keeps the raw *Bps sibling exactly as given by the provider, unaffected by percent formatting", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken()]);
    expect(row!.supplyRateBps).toBe("329");
    expect(row!.rewardsRateBps).toBe("68");
    expect(row!.totalRateBps).toBe("397");
  });

  it("formats a zero rate as 0.00%, not null or an empty string", () => {
    const [row] = projectJupiterLendRates([makeWsolToken()]);
    expect(row!.rewardsRate).toBe("0.00%");
    expect(row!.rewardsRateBps).toBe("0");
  });

  it("formats a wire number (not string) rate identically to the string form", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken({ supplyRate: 329, rewardsRate: 68, totalRate: 397 })]);
    expect(row!.supplyRate).toBe("3.29%");
    expect(row!.supplyRateBps).toBe("329");
  });

  it("formats a 5-digit rate (>= 100%) correctly", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken({ totalRate: "10000" })]);
    expect(row!.totalRate).toBe("100.00%");
  });

  it("returns null percent (never a fabricated number) for an unparseable raw rate, while preserving the raw sibling verbatim", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken({ supplyRate: "not-a-number" })]);
    expect(row!.supplyRate).toBeNull();
    expect(row!.supplyRateBps).toBe("not-a-number");
  });
});

describe("projectJupiterLendRates — identity + TVL pass-through (no truncation)", () => {
  it("keeps id/asset/earn-token identity and TVL fields, unprojected in value (raw base-unit strings)", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken()]);
    expect(row).toMatchObject({
      id: "2",
      assetAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      assetSymbol: "USDC",
      assetPriceUsd: "0.999875316937",
      earnTokenAddress: "9BEcn9aPEmhSPbPQeFGjidRiEKki46fVQDyPpSQXPA2D",
      earnTokenSymbol: "jlUSDC",
      totalAssetsRaw: "443980733216176",
      totalSupplyRaw: "421800759223650",
      assetDecimals: 6,
    });
  });

  it("drops liquiditySupplyData/rebalanceDifference/convertToShares/convertToAssets from the concise row", () => {
    const [row] = projectJupiterLendRates([makeUsdcToken()]);
    expect(row).not.toHaveProperty("liquiditySupplyData");
    expect(row).not.toHaveProperty("rebalanceDifference");
    expect(row).not.toHaveProperty("convertToShares");
  });

  it("returns every token when no filter is supplied — never a silent default cap", () => {
    const rows = projectJupiterLendRates([makeUsdcToken(), makeWsolToken()]);
    expect(rows).toHaveLength(2);
  });

  it("tolerates a non-array input defensively", () => {
    expect(projectJupiterLendRates(null)).toEqual([]);
    expect(projectJupiterLendRates(undefined)).toEqual([]);
  });
});

describe("projectJupiterLendRates — asset id-list filter", () => {
  const tokens = [makeUsdcToken(), makeWsolToken()];

  it("matches by underlying asset mint address", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetSymbol).toBe("USDC");
  });

  it("matches by Earn share-token (jlToken) mint address", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetSymbol).toBe("WSOL");
  });

  it("matches by provider lending id", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["3"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetSymbol).toBe("WSOL");
  });

  it("matches by underlying asset symbol, case-insensitively", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["usdc"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetSymbol).toBe("USDC");
  });

  it("matches by Earn share-token symbol", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["jlWSOL"] });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetSymbol).toBe("WSOL");
  });

  it("accepts multiple ids in one filter list", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["USDC", "WSOL"] });
    expect(rows).toHaveLength(2);
  });

  it("returns an empty list (not an error) when nothing matches", () => {
    expect(projectJupiterLendRates(tokens, { assets: ["nonexistent-token"] })).toEqual([]);
  });
});

describe("projectJupiterLendRates — Vex-side rate thresholds", () => {
  const tokens = [makeUsdcToken(), makeWsolToken()]; // supplyRate 3.29% / 3.89%, totalRate 3.97% / 3.89%

  it("excludes markets below minSupplyRate", () => {
    const rows = projectJupiterLendRates(tokens, { minSupplyRate: 3.5 });
    expect(rows.map((r) => r.assetSymbol)).toEqual(["WSOL"]);
  });

  it("includes a market exactly at the threshold (inclusive >=)", () => {
    const rows = projectJupiterLendRates(tokens, { minSupplyRate: 3.29 });
    expect(rows).toHaveLength(2);
  });

  it("excludes markets below minTotalRate", () => {
    const rows = projectJupiterLendRates(tokens, { minTotalRate: 3.95 });
    expect(rows.map((r) => r.assetSymbol)).toEqual(["USDC"]);
  });

  it("combines an asset filter with a rate threshold (both must pass)", () => {
    const rows = projectJupiterLendRates(tokens, { assets: ["USDC", "WSOL"], minTotalRate: 3.95 });
    expect(rows.map((r) => r.assetSymbol)).toEqual(["USDC"]);
  });

  it("excludes (not includes) a market whose rate is unparseable when a threshold is given", () => {
    const rows = projectJupiterLendRates([makeUsdcToken({ supplyRate: "bad" })], { minSupplyRate: 0 });
    expect(rows).toEqual([]);
  });
});

describe("ratesById test helper sanity", () => {
  it("finds a row by id", () => {
    const rows = projectJupiterLendRates([makeUsdcToken(), makeWsolToken()]);
    expect(ratesById(rows, "3").assetSymbol).toBe("WSOL");
  });
});
