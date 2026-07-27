/**
 * Pendle tolerant validators — built against the LIVE-probed shapes (fixtures).
 */

import { describe, it, expect } from "vitest";

import {
  validateConvert,
  validateMarkets,
  validatePositions,
  validateAssets,
  validateSupportedAggregators,
  stripChainPrefix,
} from "@tools/pendle/validation.js";
import { PENDLE_ROUTER } from "@tools/pendle/constants.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import { PENDLE_LIVE_FIXTURES as F } from "./fixtures.js";
import {
  PENDLE_CHAIN1_ASSETS,
  PENDLE_GLOBAL_ASSETS_ENVELOPE,
  PENDLE_SUPPORTED_AGGREGATORS_CHAIN1,
} from "./asset-catalog-fixtures.js";
import { requireAsset, validatedAssetsFixture } from "./validated-fixtures.js";

describe("stripChainPrefix", () => {
  it("splits a chainId-address id", () => {
    expect(stripChainPrefix("1-0xabc")).toBe("0xabc");
    expect(stripChainPrefix("0xdef")).toBe("0xdef");
    expect(stripChainPrefix(null)).toBeNull();
    expect(stripChainPrefix(123)).toBeNull();
  });
});

describe("validateConvert (from live probes)", () => {
  it("parses a buy (swap) response with the Router tx.to + one approval", () => {
    const r = validateConvert(F.buy);
    expect(r).not.toBeNull();
    expect(r!.action).toBe("swap");
    expect(r!.requiredApprovals).toHaveLength(1);
    expect(r!.routes[0]!.tx.to.toLowerCase()).toBe(PENDLE_ROUTER.toLowerCase());
    expect(r!.routes[0]!.contractParamInfo.method).toBe("swapExactTokenForPt");
    expect(r!.routes[0]!.tx.value).toBeNull();
  });

  it("parses a native buy: empty approvals + non-null tx.value", () => {
    const r = validateConvert(F.native);
    expect(r!.requiredApprovals).toHaveLength(0);
    expect(r!.routes[0]!.tx.value).toBe("1000000000000000000");
  });

  it("parses a redeem-py response with TWO approvals (YT + PT)", () => {
    const r = validateConvert(F.redeem);
    expect(r!.action).toBe("redeem-py");
    expect(r!.requiredApprovals).toHaveLength(2);
    expect(r!.routes[0]!.contractParamInfo.method).toBe("redeemPyToToken");
  });

  it("returns null when there are no usable routes", () => {
    expect(validateConvert({ action: "swap", routes: [] })).toBeNull();
    expect(validateConvert({ nonsense: true })).toBeNull();
    expect(validateConvert(null)).toBeNull();
  });
});

describe("validateMarkets (from live probes)", () => {
  it("normalizes a market and strips the chainId prefix from PT/YT/SY", () => {
    const markets = validateMarkets({ markets: [F.market] });
    expect(markets).toHaveLength(1);
    const m = markets[0]!;
    expect(m.address).toBe(F.market.address);
    expect(m.pt).toBe("0xb253eff1104802b97ac7e3ac9fdd73aece295a2c");
    expect(m.yt).toBe("0x04b7fa1e727d7290d6e24fa9b426d0c940283a95");
    expect(m.details.liquidity).toBeGreaterThan(0);
    expect(m.categoryIds).toContain("eth");
  });

  it("degrades a non-array root to an empty list", () => {
    expect(validateMarkets({ markets: "nope" })).toEqual([]);
    expect(validateMarkets(null)).toEqual([]);
  });
});

describe("validateAssets (live /v1/1/assets/all capture)", () => {
  it("normalizes price.usd + price.acc and strips the id prefix", () => {
    const assets = validateAssets([
      { id: "1-0xpt", chainId: 1, address: "0xPT", symbol: "PT-X", decimals: 18, baseType: "PT", expiry: "2027-01-01T00:00:00.000Z", price: { usd: 0.99, acc: 1 }, priceUpdatedAt: "2026-07-05T00:00:00.000Z" },
      { nonsense: true },
    ]);
    expect(assets).toHaveLength(1);
    expect(assets[0]!.address).toBe("0xPT");
    expect(assets[0]!.priceUsd).toBe(0.99);
    expect(assets[0]!.priceAcc).toBe(1);
    expect(assets[0]!.baseType).toBe("PT");
  });

  it("yields PRICED PT rows with their REAL decimals from the captured chain-1 body", () => {
    const assets = validatedAssetsFixture(PENDLE_CHAIN1_ASSETS);

    const pts = assets.filter((a) => a.baseType === "PT" && a.priceUsd !== null);
    expect(pts.length).toBeGreaterThan(0);
    // The live SIERRA PT is 6-decimal, not the 18 the old `?? 18` fallback assumed.
    const sierraPt = requireAsset(
      assets,
      "PT-SIERRA-6AUG2026",
      (a) => a.address === "0x0ee083964c815baed1a2d7f5e3cec851ec394e7d",
    );
    expect(sierraPt.baseType).toBe("PT");
    expect(sierraPt.decimals).toBe(6);
    expect(sierraPt.priceUsd).toBeGreaterThan(0);
    expect(sierraPt.priceUpdatedAt).not.toBeNull();

    // USDC is 6-decimal: the token whose assumed-18 decimals was a 10^12 error.
    const usdc = requireAsset(assets, "USDC", (a) => a.symbol === "USDC");
    expect(usdc.decimals).toBe(6);
    expect(usdc.priceUsd).toBeGreaterThan(0);

    // baseType is `PENDLE_LP` on the wire, NOT `LP`.
    expect(assets.some((a) => a.baseType === "PENDLE_LP")).toBe(true);
    expect(assets.some((a) => a.baseType === "LP")).toBe(false);
  });

  it("carries a PT with NO price through as priceUsd null instead of dropping it", () => {
    const assets = validateAssets(PENDLE_CHAIN1_ASSETS);
    const unpriced = requireAsset(assets, "an unpriced PT", (a) => a.baseType === "PT" && a.priceUsd === null);
    expect(unpriced.address).toMatch(/^0x[0-9a-f]{40}$/);
    expect(unpriced.decimals).not.toBeNull();
  });

  it("RAISES on the GLOBAL endpoint's object root instead of silently returning []", () => {
    // The exact defect: `/v1/assets/all` answers `{assets:[…]}`, the array check
    // failed, and `[]` was reported as fact on every call for months.
    expect(() => validateAssets(PENDLE_GLOBAL_ASSETS_ENVELOPE)).toThrow(VexError);
    try {
      validateAssets(PENDLE_GLOBAL_ASSETS_ENVELOPE);
      expect.unreachable("validateAssets must reject an object root");
    } catch (err) {
      expect((err as VexError).code).toBe(ErrorCodes.PENDLE_INVALID_RESPONSE);
    }
  });

  it("RAISES when rows arrive but none carries a readable address", () => {
    expect(() => validateAssets([{ nonsense: true }, { alsoNonsense: 1 }])).toThrow(VexError);
  });

  it("distinguishes a DETERMINED-EMPTY catalogue from an unreadable one", () => {
    // A genuinely empty array is a valid answer and must NOT throw.
    expect(validateAssets([])).toEqual([]);
    expect(() => validateAssets(null)).toThrow(VexError);
    expect(() => validateAssets("nope")).toThrow(VexError);
  });
});

describe("validateSupportedAggregators (live /v1/sdk/1/supported-aggregators capture)", () => {
  it("reads OBJECT entries, so chain 1 yields kyberswap AND okx", () => {
    const names = validateSupportedAggregators(PENDLE_SUPPORTED_AGGREGATORS_CHAIN1);
    expect(names).toContain("kyberswap");
    expect(names).toContain("okx");
    expect(names).toEqual(["kyberswap", "odos", "okx", "paraswap"]);
  });

  it("still accepts a bare string array and lowercases + de-dupes", () => {
    expect(validateSupportedAggregators(["KyberSwap", "kyberswap", "OKX"])).toEqual(["kyberswap", "okx"]);
  });

  it("skips entries that carry no usable name", () => {
    expect(validateSupportedAggregators({ aggregators: [{ computingUnit: 1 }, { name: "okx" }, 7] })).toEqual(["okx"]);
  });

  it("degrades an unusable root to [] so the caller falls back to kyberswap", () => {
    expect(validateSupportedAggregators(null)).toEqual([]);
    expect(validateSupportedAggregators({ unexpected: true })).toEqual([]);
  });
});

describe("validatePositions", () => {
  it("normalizes per-chain open positions with valuation", () => {
    const out = validatePositions({
      positions: [
        {
          chainId: 1,
          openPositions: [
            { marketId: "1-0xmarket", pt: { balance: "1000000000000000000", valuation: 42 }, yt: null, lp: null },
          ],
        },
      ],
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.chainId).toBe(1);
    expect(out[0]!.openPositions[0]!.pt!.valuationUsd).toBe(42);
  });
});
