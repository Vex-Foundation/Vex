/**
 * Morpho validator behaviour, driven by the VERBATIM 2026-08-14 fixtures.
 *
 * These assert the two things a tolerant reader has to get right and that a
 * fixture is the only honest way to prove: that the display/strict split drops
 * exactly the rows whose amounts would be unreadable, and that the `BigInt`
 * scalar's dual number/string serialisation survives without a float ever
 * touching a money value.
 */

import { describe, it, expect } from "vitest";
import {
  validateMorphoMarketPage,
  validateMorphoMarketDetail,
  readMarket,
  morphoInvalidResponse,
} from "../../tools/morpho/validation/markets.js";
import { requireBigIntString, requireDecimals } from "../../tools/morpho/validation/_shared.js";
import { ErrorCodes } from "../../errors.js";
import {
  MORPHO_MARKETS_PAGE,
  MORPHO_MARKET_DETAIL,
  MORPHO_MARKETS_WITH_REWARDS,
  MORPHO_MARKETS_UNLISTED,
} from "../vex-agent/tools/protocols/morpho/fixtures.js";

describe("morpho BigInt scalar reader", () => {
  it("accepts the digits-string form Morpho uses above 2^53", () => {
    expect(requireBigIntString("355405952890211270375830324")).toBe("355405952890211270375830324");
  });

  it("accepts the JSON-number form Morpho uses below 2^53, as an exact string", () => {
    expect(requireBigIntString(1483209486620379)).toBe("1483209486620379");
  });

  it("REJECTS a JSON number past MAX_SAFE_INTEGER rather than laundering the lost precision", () => {
    expect(requireBigIntString(1e30)).toBeNull();
    expect(requireBigIntString(Number.MAX_SAFE_INTEGER + 2)).toBeNull();
  });

  it("rejects signs, decimals and exponent text", () => {
    expect(requireBigIntString("-5")).toBeNull();
    expect(requireBigIntString("1.5")).toBeNull();
    expect(requireBigIntString("1e18")).toBeNull();
    expect(requireBigIntString(-1)).toBeNull();
  });
});

describe("morpho decimals reader", () => {
  it("accepts the whole-valued Float Morpho types decimals as", () => {
    expect(requireDecimals(6)).toBe(6);
    expect(requireDecimals(18)).toBe(18);
  });

  it("rejects a fractional or absent scale - every amount on that row would be unreadable", () => {
    expect(requireDecimals(6.5)).toBeNull();
    expect(requireDecimals("6")).toBeNull();
    expect(requireDecimals(undefined)).toBeNull();
  });
});

describe("validateMorphoMarketPage", () => {
  const page = validateMorphoMarketPage(MORPHO_MARKETS_PAGE);

  it("keeps every row of the live capture", () => {
    expect(page.markets).toHaveLength(3);
    expect(page.droppedRows).toBe(0);
  });

  it("reports countTotal as MATCHES, not as returned rows", () => {
    expect(page.countTotal).toBe(395);
    expect(page.count).toBe(3);
  });

  it("normalises both BigInt serialisations into decimal strings", () => {
    const [first, second] = page.markets;
    // Row 1 arrived as a JSON number, row 2's collateral as a JSON string.
    expect(first?.state?.supply.raw).toBe("1483209486620379");
    expect(second?.state?.collateral?.raw).toBe("355405952890211270375830324");
  });

  it("pairs every amount with the decimals of the asset it is denominated in", () => {
    const first = page.markets[0];
    // Loan asset USDC (6) backs supply/borrow/liquidity; collateral cbBTC (8)
    // backs the collateral leg. Mixing them is the thousandfold error rules/90 names.
    expect(first?.loanAsset.decimals).toBe(6);
    expect(first?.state?.supply.decimals).toBe(6);
    expect(first?.state?.borrow.decimals).toBe(6);
    expect(first?.state?.liquidity.decimals).toBe(6);
    expect(first?.collateralAsset?.decimals).toBe(8);
    expect(first?.state?.collateral?.decimals).toBe(8);
  });

  it("carries APY as the fraction Morpho returns, on both bases", () => {
    const apy = page.markets[0]?.state?.apy;
    expect(apy?.supplyApy).toBeCloseTo(0.04120798108290647, 12);
    expect(apy?.netSupplyApy).toBeCloseTo(0.04120798108290647, 12);
    expect(apy?.rewards).toEqual([]);
  });

  it("drops a row whose loan-asset decimals cannot be read, and counts it", () => {
    const body = structuredClone(MORPHO_MARKETS_PAGE) as {
      data: { markets: { items: Array<Record<string, unknown>> } };
    };
    (body.data.markets.items[0]["loanAsset"] as Record<string, unknown>)["decimals"] = null;
    const damaged = validateMorphoMarketPage(body);
    expect(damaged.markets).toHaveLength(2);
    expect(damaged.droppedRows).toBe(1);
  });

  it("keeps a row whose SYMBOL or price is missing - those are display fields", () => {
    const body = structuredClone(MORPHO_MARKETS_PAGE) as {
      data: { markets: { items: Array<Record<string, unknown>> } };
    };
    const loan = body.data.markets.items[0]["loanAsset"] as Record<string, unknown>;
    loan["symbol"] = null;
    loan["price"] = null;
    const tolerant = validateMorphoMarketPage(body);
    expect(tolerant.markets).toHaveLength(3);
    expect(tolerant.markets[0]?.loanAsset.symbol).toBeNull();
    expect(tolerant.markets[0]?.loanAsset.priceUsd).toBeNull();
  });

  it("raises rather than returning an empty page when EVERY row fails", () => {
    const body = structuredClone(MORPHO_MARKETS_PAGE) as {
      data: { markets: { items: Array<Record<string, unknown>> } };
    };
    for (const item of body.data.markets.items) item["marketId"] = "not-a-market-id";
    expect(() => validateMorphoMarketPage(body)).toThrowError(/all 3 market rows failed/);
  });

  it("surfaces GraphQL's own error text when there is no data block", () => {
    expect(() =>
      validateMorphoMarketPage({
        errors: [{ message: 'Cannot query field "whitelisted" on type "Market". Did you mean "listed"?' }],
      }),
    ).toThrowError(/Did you mean "listed"/);
  });
});

describe("validateMorphoMarketPage - rewards and warnings captures", () => {
  it("reads a real reward stream with its own token and scale", () => {
    const page = validateMorphoMarketPage(MORPHO_MARKETS_WITH_REWARDS);
    const reward = page.markets[0]?.state?.apy.rewards[0];
    expect(reward?.asset.symbol).toBe("WMON");
    expect(reward?.asset.decimals).toBe(18);
    expect(reward?.supplyApr).toBeCloseTo(0.010530147181825367, 12);
  });

  it("carries Morpho's RED warnings on the unlisted dust markets verbatim", () => {
    const page = validateMorphoMarketPage(MORPHO_MARKETS_UNLISTED);
    const first = page.markets[0];
    expect(first?.listed).toBe(false);
    expect(first?.warnings.map((w) => w.type)).toContain("sustained_low_liquidity");
    expect(first?.warnings.find((w) => w.type === "sustained_low_liquidity")?.level).toBe("RED");
    // 2979.957... is 297,995% - the reason listedOnly defaults to true.
    expect(first?.state?.apy.netSupplyApy).toBeGreaterThan(1000);
  });

  it("keeps the unusable-oracle warning next to a multi-billion USD figure", () => {
    const page = validateMorphoMarketPage(MORPHO_MARKETS_UNLISTED);
    const second = page.markets[1];
    expect(second?.warnings.map((w) => w.type)).toContain("oracle_unusable");
    expect(second?.state?.supply.usd).toBeGreaterThan(1e9);
  });
});

describe("validateMorphoMarketDetail", () => {
  const options = { includeHistory: true, lookback: "thirty_days", includeSupplyingVaults: true } as const;
  const detail = validateMorphoMarketDetail(MORPHO_MARKET_DETAIL, options);

  it("sums Public Allocator liquidity PER VAULT instead of repeating pair rows", () => {
    // The capture has 22 rows naming 7 distinct vaults; Steakhouse High Yield
    // USDC v1.1 alone appears 8 times.
    expect(detail.sharedLiquidity.length).toBeLessThan(22);
    const addresses = detail.sharedLiquidity.map((entry) => entry.vaultAddress);
    expect(new Set(addresses).size).toBe(addresses.length);
    for (const entry of detail.sharedLiquidity) expect(entry.assetsRaw).toMatch(/^\d+$/);
  });

  it("computes the oracle price scale as 36 + loanDecimals - collateralDecimals", () => {
    expect(detail.loanAsset.decimals).toBe(6);
    expect(detail.collateralAsset?.decimals).toBe(8);
    expect(detail.oraclePriceScaleDecimals).toBe(34);
    expect(detail.oraclePriceRaw).toBe("627464420000000000000000000000000000000");
  });

  it("returns the requested averaging window from its fixed field names", () => {
    expect(detail.apyWindow?.supplyApy).toBeCloseTo(0.044847218661766775, 12);
    expect(detail.apyWindow?.netSupplyApy).toBeCloseTo(0.044847218661766775, 12);
  });

  it("omits the window entirely when includeHistory is false", () => {
    const without = validateMorphoMarketDetail(MORPHO_MARKET_DETAIL, { ...options, includeHistory: false });
    expect(without.apyWindow).toBeNull();
  });

  it("omits supplying vaults entirely when not requested, rather than returning []", () => {
    const without = validateMorphoMarketDetail(MORPHO_MARKET_DETAIL, { ...options, includeSupplyingVaults: false });
    expect(without.supplyingVaults).toBeNull();
    expect(detail.supplyingVaults?.length).toBeGreaterThan(0);
  });

  it("reports a null marketById as NOT FOUND, not as a malformed response", () => {
    expect(() => validateMorphoMarketDetail({ data: { marketById: null } }, options)).toThrowError(
      /no market with that id on that chain/,
    );
  });
});

describe("morphoInvalidResponse", () => {
  it("carries the coded contract-drift error with a remediation", () => {
    const err = morphoInvalidResponse("test detail");
    expect(err.code).toBe(ErrorCodes.MORPHO_INVALID_RESPONSE);
    expect(err.hint).toMatch(/deprecates GraphQL fields/);
  });
});

describe("readMarket", () => {
  it("returns null for a non-record rather than throwing", () => {
    expect(readMarket("nope")).toBeNull();
    expect(readMarket(null)).toBeNull();
  });
});
