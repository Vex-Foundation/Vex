/**
 * The bonding-curve arithmetic, held to the CONTRACT rather than to intuition.
 *
 * Every expectation here is derived from the Solidity in
 * `agents-colab/protocol-contracts/contracts/launchpadv2/`:
 *
 *   `FRouterV3.sol:202-230`  the buy split (normal tax, anti-sniper tax, remainder)
 *   `FRouterV3.sol:155-170`  the sell split, applied to the router's GROSS output
 *   `FRouterV3.sol:161-163`, `:211-213`  the `normalTax + antiSniperTax > 99` clamp
 *   `FRouterV3.sol:309-355`  the linear anti-sniper decay and its three edges
 *   `BondingV5.sol:687-688`, `:728-730`  which figure each side's floor bounds
 *
 * The rounding-boundary cases are the point of the file. Integer division at
 * three separate points means a formula that is "the same up to rounding" is a
 * formula the chain will not honour, and the 99-percent clamp is reachable on a
 * real launch's first minute rather than being a theoretical edge.
 */

import { describe, expect, it } from "vitest";

import {
  applySlippageFloor,
  computeBuyLegs,
  computeSellFloors,
  effectiveAntiSniperPct,
  MAX_COMBINED_TAX_PCT,
  percentOf,
  rawAntiSniperPctAt,
  splitCurveTax,
} from "@tools/virtuals/curve/quote-math.js";

describe("effectiveAntiSniperPct - the router's own clamp", () => {
  it("leaves an anti-sniper percent alone while the pair fits under 99", () => {
    // 1 + 50 = 51, well under the ceiling: nothing is clamped.
    expect(effectiveAntiSniperPct(50, 1)).toBe(50);
  });

  it("clamps the anti-sniper component so the PAIR never exceeds 99 percent", () => {
    // `FRouterV3` sets `antiSniperTax = 99 - normalTax` the instant the sum
    // would pass 99, which is the state of every launch in its first seconds:
    // the raw component starts at 99 and the protocol tax is 1.
    expect(effectiveAntiSniperPct(99, 1)).toBe(98);
    expect(effectiveAntiSniperPct(99, 0)).toBe(99);
    expect(effectiveAntiSniperPct(99, 25)).toBe(74);
  });

  it("refuses a percent that is not a whole percent in range", () => {
    expect(() => effectiveAntiSniperPct(1.5, 1)).toThrow(RangeError);
    expect(() => effectiveAntiSniperPct(-1, 1)).toThrow(RangeError);
    expect(() => effectiveAntiSniperPct(101, 1)).toThrow(RangeError);
  });
});

describe("percentOf - the contract's `(tax * amount) / 100`", () => {
  it("floors, never rounds", () => {
    // 99 * 1 / 100 = 0.99 -> 0. A rounded 1 here would take a unit the contract
    // never takes, and the whole `taxedIn` would be one unit short.
    expect(percentOf(99n, 1)).toBe(0n);
    expect(percentOf(100n, 1)).toBe(1n);
    expect(percentOf(199n, 1)).toBe(1n);
  });

  it("is exact at sizes no double could hold", () => {
    const huge = 123_456_789_012_345_678_901_234_567_890n;
    expect(percentOf(huge, 25)).toBe((huge * 25n) / 100n);
  });
});

describe("splitCurveTax - the buy and sell split", () => {
  it("pins the rounding-boundary case the plan names: 99 raw, 1% tax, 1% anti", () => {
    // Both fees floor to zero at this size, so the FULL 99 reaches the curve.
    // This is the case that separates the contract's arithmetic from any
    // formula that computes `amount * (100 - taxes) / 100` in one step, which
    // would give 98 here.
    const split = splitCurveTax(99n, 1, 1);
    expect(split.normalFeeRaw).toBe(0n);
    expect(split.antiSniperFeeRaw).toBe(0n);
    expect(split.netRaw).toBe(99n);
  });

  it("never lets the remainder go negative, even at the 99 percent ceiling", () => {
    const split = splitCurveTax(10_000n, 1, 99);
    expect(split.effectiveAntiPct).toBe(98);
    expect(split.normalFeeRaw).toBe(100n);
    expect(split.antiSniperFeeRaw).toBe(9_800n);
    expect(split.netRaw).toBe(100n);
    expect(split.netRaw).toBeGreaterThanOrEqual(0n);
  });

  it("keeps the three parts summing to the base at every size", () => {
    for (const base of [1n, 7n, 99n, 100n, 101n, 12_345n, 10n ** 24n]) {
      for (const [tax, anti] of [[1, 0], [1, 1], [1, 99], [0, 0], [5, 40]] as const) {
        const split = splitCurveTax(base, tax, anti);
        expect(split.normalFeeRaw + split.antiSniperFeeRaw + split.netRaw).toBe(base);
      }
    }
  });

  it("refuses a protocol tax the router could not clamp against", () => {
    // `99 - normalTax` underflows in Solidity above 99; Vex refuses rather than
    // folding the impossible state to zero.
    expect(() => splitCurveTax(100n, MAX_COMBINED_TAX_PCT + 1, 0)).toThrow(RangeError);
  });
});

describe("computeBuyLegs", () => {
  it("quotes the curve for the amount AFTER both taxes", () => {
    const legs = computeBuyLegs({ curveAmountRaw: 1_000_000n, buyTaxPct: 1, rawAntiSniperBuyPct: 0 });
    expect(legs.tax.normalFeeRaw).toBe(10_000n);
    expect(legs.taxedInRaw).toBe(990_000n);
    expect(legs.curveAmountRaw).toBe(1_000_000n);
  });

  it("applies the clamp on the buy side inside its window", () => {
    const legs = computeBuyLegs({ curveAmountRaw: 1_000_000n, buyTaxPct: 1, rawAntiSniperBuyPct: 99 });
    expect(legs.tax.effectiveAntiPct).toBe(98);
    expect(legs.taxedInRaw).toBe(10_000n);
  });
});

describe("applySlippageFloor", () => {
  it("subtracts the tolerance and floors", () => {
    expect(applySlippageFloor(10_000n, 100)).toBe(9_900n);
    expect(applySlippageFloor(1n, 100)).toBe(0n);
    expect(applySlippageFloor(12_345n, 300)).toBe((12_345n * 9_700n) / 10_000n);
  });

  it("is the identity at zero tolerance", () => {
    expect(applySlippageFloor(777n, 0)).toBe(777n);
  });

  it("refuses a tolerance that is not whole basis points in range", () => {
    expect(() => applySlippageFloor(1n, 0.5)).toThrow(RangeError);
    expect(() => applySlippageFloor(1n, -1)).toThrow(RangeError);
    expect(() => applySlippageFloor(1n, 10_001)).toThrow(RangeError);
  });
});

describe("computeSellFloors - the gross floor is the only enforced one", () => {
  const gross = 1_000_000_000n;

  it("bounds the GROSS output, then estimates the wallet net from it", () => {
    const floors = computeSellFloors({
      quotedGrossRaw: gross,
      sellTaxPct: 1,
      rawAntiSniperSellPct: 0,
      slippageBps: 300,
    });
    // The contract compares THIS number against the router's gross output.
    expect(floors.contractGrossMinRaw).toBe((gross * 9_700n) / 10_000n);
    // The wallet estimate is that floor minus the taxes, computed the way the
    // contract computes them - on the realised gross, floored.
    expect(floors.walletNetMinRaw).toBe(
      floors.contractGrossMinRaw - (floors.contractGrossMinRaw * 1n) / 100n,
    );
    // And the net at the quoted gross is a different, larger number: the two are
    // never interchangeable and the preview shows both.
    expect(floors.walletNetQuotedRaw).toBe(gross - gross / 100n);
    expect(floors.walletNetQuotedRaw).toBeGreaterThan(floors.walletNetMinRaw);
  });

  it("carries the anti-sniper component into the estimate when the sell side is taxed", () => {
    const floors = computeSellFloors({
      quotedGrossRaw: gross,
      sellTaxPct: 1,
      rawAntiSniperSellPct: 40,
      slippageBps: 0,
    });
    expect(floors.tax.effectiveAntiPct).toBe(40);
    expect(floors.walletNetQuotedRaw).toBe(gross - gross / 100n - (gross * 40n) / 100n);
  });
});

describe("rawAntiSniperPctAt - the decay, transcribed", () => {
  const base = {
    appliesOnThisSide: true,
    durationSeconds: 60,
    taxStartTimeSeconds: 1_000,
    startTaxPct: 99,
  };

  it("is zero on a side this type does not tax", () => {
    expect(rawAntiSniperPctAt({ ...base, appliesOnThisSide: false, nowSeconds: 1_010 })).toBe(0);
  });

  it("is zero when the type has no window at all", () => {
    expect(rawAntiSniperPctAt({ ...base, durationSeconds: 0, nowSeconds: 1_010 })).toBe(0);
  });

  it("is the FULL start tax before trading has started", () => {
    // The arm the API-row estimator cannot model: a scheduled launch whose tax
    // clock has not begun is taxed at the maximum, not at zero.
    expect(rawAntiSniperPctAt({ ...base, nowSeconds: 999 })).toBe(99);
  });

  it("decays linearly with integer division inside the window", () => {
    expect(rawAntiSniperPctAt({ ...base, nowSeconds: 1_000 })).toBe(99);
    expect(rawAntiSniperPctAt({ ...base, nowSeconds: 1_030 })).toBe(Math.floor((99 * 30) / 60));
    expect(rawAntiSniperPctAt({ ...base, nowSeconds: 1_059 })).toBe(Math.floor((99 * 1) / 60));
  });

  it("is zero the instant the window closes, and stays zero", () => {
    expect(rawAntiSniperPctAt({ ...base, nowSeconds: 1_060 })).toBe(0);
    expect(rawAntiSniperPctAt({ ...base, nowSeconds: 99_999 })).toBe(0);
  });
});
