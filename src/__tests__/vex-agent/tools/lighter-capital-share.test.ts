/**
 * The agent's Lighter capital share: the arithmetic that decides whether an
 * approved order fits the percent of collateral the user authorized.
 *
 * Every fixture number here is LIVE-SHAPED, taken from the 2026-09-10 probes of
 * `api.rh.lighter.xyz`: `collateral` and `cross_initial_margin_requirement` are
 * six-decimal strings ("7.884034", "0.000000"), a position row's
 * `initial_margin_fraction` is a PERCENT STRING ("50.00"), and BTC market 1
 * reports `supported_size_decimals` 5, `supported_price_decimals` 1,
 * `supported_quote_decimals` 6, `default_initial_margin_fraction` 5000,
 * `min_initial_margin_fraction` 200 and `taker_fee` "0.0000". A fixture that
 * used plain integers would prove nothing about the strings the provider sends.
 */

import { describe, expect, it } from "vitest";

import {
  assertLighterOrderCapitalShare,
  assessLighterOrderCapitalShare,
  computeLighterCapitalBudget,
  computeLighterOrderRequiredCapital,
  formatCapitalUnits,
  resolveLighterCapitalRiskPriceInteger,
  resolveLighterInitialMarginFraction,
  type LighterCapitalBudget,
  type LighterOrderRequiredCapital,
} from "@tools/lighter/capital-share.js";
import { ErrorCodes, VexError } from "../../../errors.js";

const BTC_MARKET = {
  supported_size_decimals: 5,
  supported_price_decimals: 1,
  supported_quote_decimals: 6,
  default_initial_margin_fraction: 5000,
  min_initial_margin_fraction: 200,
} as const;

function budget(overrides: Partial<Parameters<typeof computeLighterCapitalBudget>[0]> = {}): LighterCapitalBudget {
  return computeLighterCapitalBudget({
    agentCapitalSharePercent: 50,
    collateral: "7.884034",
    crossInitialMarginRequirement: "0.000000",
    isolatedAllocatedMargins: [],
    restingOrderReservedMarginUnits: [],
    vexLiveIntentUnits: [],
    ...overrides,
  });
}

describe("computeLighterCapitalBudget", () => {
  it("takes the share of live six-decimal collateral and rounds the budget DOWN", () => {
    // 7.884034 USDG at 50% is 3.942017 exactly; at 33% it is 2.60173122, which
    // must floor to 2.601731 rather than round up into capital the user never
    // authorized.
    expect(budget().budgetUnits).toBe("3942017");
    expect(budget({ agentCapitalSharePercent: 33 }).budgetUnits).toBe("2601731");
  });

  it("sums the conservative superset of commitments and never reports a negative remainder", () => {
    const result = budget({
      agentCapitalSharePercent: 50,
      crossInitialMarginRequirement: "1.500000",
      isolatedAllocatedMargins: ["0.250000", "0.100000"],
      restingOrderReservedMarginUnits: ["400000"],
      vexLiveIntentUnits: ["2000000"],
    });
    expect(result.committedUnits).toBe("4250000");
    expect(result.committedBreakdown).toEqual({
      providerCrossInitialMarginUnits: "1500000",
      isolatedAllocatedMarginUnits: "350000",
      restingOrderReservedMarginUnits: "400000",
      vexLiveIntentUnits: "2000000",
    });
    // Committed exceeds the 3.942017 budget, so nothing remains. It must clamp
    // to zero, never go negative and let a later subtraction read as headroom.
    expect(result.remainingUnits).toBe("0");
  });

  it("refuses a malformed or missing financial field BY NAME instead of reading it as zero", () => {
    // A zero here would silently WIDEN the ceiling, which is the whole failure
    // mode the strict parse exists to stop.
    expect(() => budget({ collateral: "" })).toThrow(/collateral/);
    expect(() => budget({ crossInitialMarginRequirement: "n/a" }))
      .toThrow(/cross_initial_margin_requirement/);
    expect(() => budget({ isolatedAllocatedMargins: ["1.2345678"] }))
      .toThrow(/more than 6 decimals/);
    expect(() => budget({ crossInitialMarginRequirement: "-1.000000" })).toThrow(/negative/);
  });

  it("refuses a share that is not a whole percent in 1..100 and never coerces it", () => {
    expect(() => budget({ agentCapitalSharePercent: 0 })).toThrow(/NOT coerced/);
    expect(() => budget({ agentCapitalSharePercent: 101 })).toThrow(/NOT coerced/);
    expect(() => budget({ agentCapitalSharePercent: 12.5 })).toThrow(/NOT coerced/);
  });
});

describe("resolveLighterCapitalRiskPriceInteger", () => {
  it("prices a BUY at its APPROVED bound, not at the live best quote", () => {
    // A market buy may execute anywhere up to its slippage bound, so the bound
    // is the exposure the user approved. Pricing it at the book would understate
    // exactly the order that can move the furthest.
    const result = resolveLighterCapitalRiskPriceInteger({
      side: "buy",
      approvedPriceInteger: "800000",
      approvedPriceRole: "worst_acceptable_price",
      priceDecimals: 1,
      markPrice: "77329.8",
    });
    expect(result).toEqual({
      ok: true,
      priceInteger: "800000",
      basis: "approved_execution_bound",
    });
  });

  it("prices a crossing SELL at MARK when its limit price sits far below it", () => {
    // A sell's submitted price is a minimum it will accept, not a bound on the
    // short's margin, which follows the market.
    const result = resolveLighterCapitalRiskPriceInteger({
      side: "sell",
      approvedPriceInteger: "700000",
      approvedPriceRole: "limit_price",
      priceDecimals: 1,
      markPrice: "77329.8",
    });
    expect(result).toEqual({ ok: true, priceInteger: "773298", basis: "mark_price" });
  });

  it("keeps a SELL's own limit price when it is above mark", () => {
    expect(resolveLighterCapitalRiskPriceInteger({
      side: "sell",
      approvedPriceInteger: "900000",
      approvedPriceRole: "limit_price",
      priceDecimals: 1,
      markPrice: "77329.8",
    })).toEqual({ ok: true, priceInteger: "900000", basis: "approved_limit_price" });
  });

  it("refuses an order with no approved price bound rather than guessing one", () => {
    const result = resolveLighterCapitalRiskPriceInteger({
      side: "buy",
      approvedPriceInteger: "0",
      approvedPriceRole: "worst_acceptable_price",
      priceDecimals: 1,
      markPrice: "77329.8",
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no approved price bound/);
  });

  it("refuses a SELL when the market reported no mark price", () => {
    const result = resolveLighterCapitalRiskPriceInteger({
      side: "sell",
      approvedPriceInteger: "700000",
      approvedPriceRole: "limit_price",
      priceDecimals: 1,
      markPrice: null,
    });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/no mark price/);
  });
});

describe("computeLighterOrderRequiredCapital", () => {
  function required(
    overrides: Partial<Parameters<typeof computeLighterOrderRequiredCapital>[0]> = {},
  ): LighterOrderRequiredCapital {
    return computeLighterOrderRequiredCapital({
      // 0.00020 BTC, the live market minimum, at the live mark 77329.8.
      baseAmountInteger: "20",
      riskPriceInteger: "773298",
      riskPriceBasis: "approved_execution_bound",
      sizeDecimals: BTC_MARKET.supported_size_decimals,
      priceDecimals: BTC_MARKET.supported_price_decimals,
      quoteDecimals: BTC_MARKET.supported_quote_decimals,
      initialMarginFraction: 5000,
      exchangeTakerFeePercent: "0.0000",
      exchangeAccountTakerFeeTicks: 0,
      vexIntegratorTakerFeeTicks: null,
      ...overrides,
    });
  }

  it("computes notional x imf / 10000, matching the official sizing identity", () => {
    // The official SDK example sizes an order as margin x leverage = notional,
    // so margin = notional / leverage = notional x imf / 10000. At 5000 (2x) the
    // 15.465960 USDG notional requires exactly half of it.
    const result = required();
    expect(result.notionalUnits).toBe("15465960");
    expect(result.initialMarginUnits).toBe("7732980");
    expect(result.requiredUnits).toBe("7732980");
  });

  it("needs 50x less margin at the market's maximum leverage than at its default", () => {
    // The exact confusion this whole arc exists to fix: 5000 is 2x and 200 is
    // 50x, on the SAME market.
    expect(required({ initialMarginFraction: 200 }).initialMarginUnits).toBe("309320");
  });

  it("adds the exchange taker fee and the VEX integrator fee, both rounded UP", () => {
    const result = required({
      exchangeTakerFeePercent: "1.0000",
      vexIntegratorTakerFeeTicks: 1_000,
    });
    // 1% of 15.465960 is 0.1546596, which must round UP to 0.154660.
    expect(result.exchangeTakerFeeUnits).toBe("154660");
    // 1000 ticks is 0.1%: 0.01546596, rounded up.
    expect(result.vexIntegratorFeeUnits).toBe("15466");
    expect(result.requiredUnits).toBe("7903106");
  });

  it("charges THIS ACCOUNT's exchange fee tier when it exceeds the market's own fee", () => {
    // The defect this proves gone: the market advertises a ZERO taker fee while
    // this account's own tier charges 0.1%, so a requirement built on
    // `market.taker_fee` alone reserved nothing for a charge the exchange will
    // certainly take, and an order at the ceiling was admitted short. The
    // preview already prices its taker-fee estimate at the LARGER of the two
    // (`order-preview.ts`); the ceiling now agrees with it.
    const result = required({
      exchangeTakerFeePercent: "0.0000",
      exchangeAccountTakerFeeTicks: 1_000,
    });
    // 1000 ticks is 0.1% of 15.465960 = 0.01546596, rounded UP.
    expect(result.exchangeTakerFeeUnits).toBe("15466");
    expect(result.requiredUnits).toBe("7748446");
  });

  it("keeps the MARKET's fee when it is the larger of the two", () => {
    const result = required({
      exchangeTakerFeePercent: "1.0000",
      exchangeAccountTakerFeeTicks: 1_000,
    });
    expect(result.exchangeTakerFeeUnits).toBe("154660");
  });

  it("refuses an absent account fee tier instead of pricing the order at zero", () => {
    // The override is spread in, so the key IS present and carries `undefined`:
    // exactly what a caller that forgot to read the tier hands the arithmetic.
    expect(() => required({ exchangeAccountTakerFeeTicks: undefined }))
      .toThrow(/exchangeAccountTakerFeeTicks is undefined/);
  });

  it("asserts the market's quote scale BY NAME instead of rescaling a scale it cannot verify", () => {
    // `supported_quote_decimals` must equal size + price decimals. A silent
    // 10^n slip here is the thousandfold error rule 90 exists to prevent.
    expect(() => required({ quoteDecimals: 8 }))
      .toThrow(/market quote scale 8 is not supported_size_decimals 5 plus supported_price_decimals 1/);
  });

  it("rescales a non-6 quote scale UP, so a rescale never understates the obligation", () => {
    // A market whose quote scale is 8 (size 6 + price 2) carries a notional two
    // decimal places finer than settlement, and the leftover must round up.
    const result = required({
      baseAmountInteger: "1",
      riskPriceInteger: "1",
      sizeDecimals: 6,
      priceDecimals: 2,
      quoteDecimals: 8,
      initialMarginFraction: 10_000,
    });
    expect(result.notionalUnits).toBe("1");
  });

  it("refuses an initial margin fraction outside Lighter's 1..10000 scale", () => {
    expect(() => required({ initialMarginFraction: 0 })).toThrow(/1\.\.10000 scale/);
    expect(() => required({ initialMarginFraction: 10_001 })).toThrow(/1\.\.10000 scale/);
  });
});

describe("resolveLighterInitialMarginFraction", () => {
  it("reads the account's own PERCENT STRING row through the converter, never locally", () => {
    expect(resolveLighterInitialMarginFraction({
      positionRow: { initial_margin_fraction: "50.00" },
      market: BTC_MARKET,
    })).toEqual({ initialMarginFraction: 5000, source: "position_row" });
  });

  it("falls back to the MARKET's own default when the account has no row", () => {
    // Core's default differs from Robinhood Chain's, so a hardcoded 2x would be
    // wrong on one of them.
    expect(resolveLighterInitialMarginFraction({ positionRow: null, market: BTC_MARKET }))
      .toEqual({ initialMarginFraction: 5000, source: "market_default" });
    expect(resolveLighterInitialMarginFraction({
      positionRow: null,
      market: { default_initial_margin_fraction: 500 },
    })).toEqual({ initialMarginFraction: 500, source: "market_default" });
  });

  it("refuses when neither a row nor a market default exists", () => {
    expect(() => resolveLighterInitialMarginFraction({
      positionRow: null,
      market: { default_initial_margin_fraction: undefined },
    })).toThrow(/no default_initial_margin_fraction/);
  });
});

describe("assessLighterOrderCapitalShare", () => {
  const base = {
    walletAddress: "0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa",
    accountIndex: 24226,
    marketType: "perp",
    side: "buy" as const,
    reduceOnly: false,
    initialMarginFractionSource: "position_row" as const,
  };
  const remaining = (units: string): LighterCapitalBudget => ({
    agentCapitalSharePercent: 50,
    collateralUnits: "7884034",
    budgetUnits: "3942017",
    committedUnits: (3_942_017n - BigInt(units)).toString(),
    remainingUnits: units,
    committedBreakdown: {
      providerCrossInitialMarginUnits: "0",
      isolatedAllocatedMarginUnits: "0",
      restingOrderReservedMarginUnits: "0",
      vexLiveIntentUnits: "0",
    },
  });
  const needs = (units: string): LighterOrderRequiredCapital => ({
    requiredUnits: units,
    notionalUnits: "0",
    initialMarginUnits: units,
    exchangeTakerFeeUnits: "0",
    vexIntegratorFeeUnits: "0",
    initialMarginFraction: 5000,
    riskPriceInteger: "773298",
    riskPriceBasis: "approved_execution_bound",
  });

  it("applies NO ceiling when the user has not set a share", () => {
    // `null` is the user declining to set one, not zero authority. The owner
    // withdrew the strict option.
    expect(assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: null,
      budget: null,
      required: null,
    })).toEqual({ applies: false, exemption: "no_share_configured" });
  });

  it("exempts a reduce-only order, which reduces exposure", () => {
    expect(assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: 50,
      reduceOnly: true,
      budget: null,
      required: null,
    })).toEqual({ applies: false, exemption: "reduce_only" });
  });

  it("exempts a spot SELL but REFUSES a spot BUY under a configured share", () => {
    expect(assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: 50,
      marketType: "spot",
      side: "sell",
      budget: null,
      required: null,
    })).toEqual({ applies: false, exemption: "spot_sell" });

    // A spot buy settles into inventory that leaves `committed` entirely, so
    // repeated buys could walk past the share while each one passed.
    const buy = assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: 50,
      marketType: "spot",
      side: "buy",
      budget: null,
      required: null,
    });
    expect(buy.applies).toBe(true);
    expect(buy.applies && "refusal" in buy && buy.refusal).toMatch(/spot buy is refused/);
    expect(buy.applies && "refusal" in buy && buy.refusal)
      .toMatch(/Settings -> Lighter -> Trading setup/);
  });

  it("trades spot as before when NO share is configured", () => {
    expect(assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: null,
      marketType: "spot",
      side: "buy",
      budget: null,
      required: null,
    })).toEqual({ applies: false, exemption: "no_share_configured" });
  });

  it("passes at the EXACT boundary and refuses one single unit over it", () => {
    const exact = assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: 50,
      budget: remaining("7732980"),
      required: needs("7732980"),
    });
    expect(exact.applies && "assessment" in exact && exact.assessment.passes).toBe(true);

    const over = assessLighterOrderCapitalShare({
      ...base,
      agentCapitalSharePercent: 50,
      budget: remaining("7732980"),
      required: needs("7732981"),
    });
    expect(over.applies && "assessment" in over && over.assessment.passes).toBe(false);
  });
});

describe("assertLighterOrderCapitalShare", () => {
  const over = {
    agentCapitalSharePercent: 50,
    walletAddress: "0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa",
    accountIndex: 24226,
    marketType: "perp",
    side: "buy" as const,
    reduceOnly: false,
    initialMarginFractionSource: "position_row" as const,
    budget: {
      agentCapitalSharePercent: 50,
      collateralUnits: "7884034",
      budgetUnits: "3942017",
      committedUnits: "0",
      remainingUnits: "3942017",
      committedBreakdown: {
        providerCrossInitialMarginUnits: "0",
        isolatedAllocatedMarginUnits: "0",
        restingOrderReservedMarginUnits: "0",
        vexLiveIntentUnits: "0",
      },
    },
    required: {
      requiredUnits: "7732980",
      notionalUnits: "15465960",
      initialMarginUnits: "7732980",
      exchangeTakerFeeUnits: "0",
      vexIntegratorFeeUnits: "0",
      initialMarginFraction: 5000,
      riskPriceInteger: "773298",
      riskPriceBasis: "approved_execution_bound" as const,
    },
  };

  it("throws LIGHTER_CAPITAL_SHARE_EXCEEDED naming BOTH numbers and the remedy", () => {
    // Both numbers, because a refusal that named only one would leave the user
    // unable to tell whether to raise the share or shrink the order.
    let thrown: unknown;
    try {
      assertLighterOrderCapitalShare(over);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(VexError);
    expect((thrown as VexError).code).toBe(ErrorCodes.LIGHTER_CAPITAL_SHARE_EXCEEDED);
    const message = (thrown as VexError).message;
    expect(message).toContain("7.732980");
    expect(message).toContain("3.942017");
    expect(message).toContain("50%");
    expect(message).toContain("Settings -> Lighter -> Trading setup");
  });

  it("NEVER resizes the order to fit", () => {
    // The order is the user's; silently shrinking it would hide that the agent
    // tried to commit more than they authorized.
    expect(() => assertLighterOrderCapitalShare(over)).toThrow(/NOT resized/);
  });

  it("returns the outcome untouched when the order fits", () => {
    const outcome = assertLighterOrderCapitalShare({
      ...over,
      required: { ...over.required, requiredUnits: "1000000" },
    });
    expect(outcome.applies && "assessment" in outcome && outcome.assessment.passes).toBe(true);
  });
});

describe("formatCapitalUnits", () => {
  it("renders settlement units at six decimals", () => {
    expect(formatCapitalUnits("3942017")).toBe("3.942017");
    expect(formatCapitalUnits("0")).toBe("0.000000");
    expect(formatCapitalUnits("7884034")).toBe("7.884034");
  });
});
