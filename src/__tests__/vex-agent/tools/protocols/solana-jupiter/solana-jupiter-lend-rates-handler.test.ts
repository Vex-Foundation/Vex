/**
 * Handler-level wiring test for `solana.lend.rates` (W1-I) — proves the
 * manifest's `assets`/`minSupplyRate`/`minTotalRate` params actually reach
 * the concise projector, and that the handler's success path returns a
 * projected (not raw) row. Projector formatting/filter behavior itself is
 * covered by solana-jupiter-lend-projector.test.ts; this file only proves
 * the handler seam wires params through correctly.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type { JupiterLendEarnTokenInfo } from "@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/types.js";

const { getJupiterLendEarnTokens } = vi.hoisted(() => ({
  getJupiterLendEarnTokens: vi.fn(),
}));

// B2 deleted `executeJupiterLendEarnDeposit`/`executeJupiterLendEarnWithdraw`
// (unreachable since K6's staged-seam conversion) — this file only exercises
// `solana.lend.rates`, which never touched them; the mock keys were obsolete
// cruft (B3, item 5).
vi.mock("@tools/solana-ecosystem/jupiter/jupiter-lend/earn-api/service.js", () => ({
  getJupiterLendEarnTokens,
  getJupiterLendEarnPositions: vi.fn(),
  getJupiterLendEarnEarnings: vi.fn(),
}));

import { LEND_HANDLERS } from "@vex-agent/tools/protocols/solana-jupiter/handlers/lend.js";

function ctx(over: Partial<ProtocolExecutionContext> = {}): ProtocolExecutionContext {
  return {
    sessionPermission: "restricted",
    approved: false,
    walletResolution: { source: "default" },
    walletPolicy: { kind: "none" },
    ...over,
  };
}

const USDC_TOKEN: JupiterLendEarnTokenInfo = {
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
};

const WSOL_TOKEN: JupiterLendEarnTokenInfo = {
  ...USDC_TOKEN,
  id: 3,
  address: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU",
  symbol: "jlWSOL",
  assetAddress: "So11111111111111111111111111111111111111112",
  asset: { ...USDC_TOKEN.asset, address: "So11111111111111111111111111111111111111112", symbol: "WSOL" },
  supplyRate: "389",
  rewardsRate: "0",
  totalRate: "389",
};

describe("solana.lend.rates handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns every market projected (percent + raw *Bps sibling), unfiltered when no params are given", async () => {
    getJupiterLendEarnTokens.mockResolvedValueOnce([USDC_TOKEN, WSOL_TOKEN]);

    const result = await LEND_HANDLERS["solana.lend.rates"]!({}, ctx());

    expect(result.success).toBe(true);
    const rows = result.data as unknown as Array<{ assetSymbol: string; supplyRate: string; supplyRateBps: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ assetSymbol: "USDC", supplyRate: "3.29%", supplyRateBps: "329" });
  });

  it("applies the assets filter param through to the projector", async () => {
    getJupiterLendEarnTokens.mockResolvedValueOnce([USDC_TOKEN, WSOL_TOKEN]);

    const result = await LEND_HANDLERS["solana.lend.rates"]!({ assets: "WSOL" }, ctx());

    expect(result.success).toBe(true);
    const rows = result.data as unknown as Array<{ assetSymbol: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.assetSymbol).toBe("WSOL");
  });

  it("applies the minTotalRate threshold param through to the projector", async () => {
    getJupiterLendEarnTokens.mockResolvedValueOnce([USDC_TOKEN, WSOL_TOKEN]);

    // Both fixtures' totalRate (3.97% / 3.89%) sit well below 5% — proves the
    // param reaches the projector and actually narrows the result, not just
    // that it's accepted.
    const result = await LEND_HANDLERS["solana.lend.rates"]!({ minTotalRate: 5 }, ctx());

    expect(result.success).toBe(true);
    const rows = result.data as unknown as Array<{ assetSymbol: string }>;
    expect(rows).toEqual([]);
  });

  it("applies the minSupplyRate threshold param through to the projector", async () => {
    getJupiterLendEarnTokens.mockResolvedValueOnce([USDC_TOKEN, WSOL_TOKEN]);

    const result = await LEND_HANDLERS["solana.lend.rates"]!({ minSupplyRate: 3.5 }, ctx());

    expect(result.success).toBe(true);
    const rows = result.data as unknown as Array<{ assetSymbol: string }>;
    expect(rows).toEqual([{
      id: "3",
      assetAddress: "So11111111111111111111111111111111111111112",
      assetSymbol: "WSOL",
      assetPriceUsd: "0.999875316937",
      earnTokenAddress: "2uQsyo1fXXQkDtcpXnLofWy88PxcvnfH2L8FPSE62FVU",
      earnTokenSymbol: "jlWSOL",
      supplyRate: "3.89%",
      supplyRateBps: "389",
      rewardsRate: "0.00%",
      rewardsRateBps: "0",
      totalRate: "3.89%",
      totalRateBps: "389",
      totalAssetsRaw: "443980733216176",
      totalSupplyRaw: "421800759223650",
      assetDecimals: 6,
    }]);
  });
});
