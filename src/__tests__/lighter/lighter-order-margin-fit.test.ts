/**
 * Lighter's post-trade margin check, replayed on the orders account 31824 sent
 * on Robinhood Chain on 2026-09-24. Six ETH orders sized at the ticket's 100%
 * were cancelled `canceled-margin-not-allowed` with no fill while a BTC order
 * sized the same way filled. The account paid a 0.035% Premium taker tier on
 * markets whose published `taker_fee` read 0, plus Vex's 0.1%.
 *
 * Book and balance figures are the ones recorded on those intents and
 * reconstructed from the account's fills; the mark is the book mid at send
 * time, since the provider does not keep a mark history.
 */

import { describe, expect, it } from "vitest";

import {
  assessLighterOrderMarginFit,
  LIGHTER_UNREAD_EXCHANGE_FEE_TICKS,
  type LighterOrderMarginFitInput,
} from "@tools/lighter/order-margin-fit.js";

/** 0.0667 ETH market buy, bound 2704.61, ask 2691.15, 8.792317 USDG available. */
const ETH_BUY_0648: LighterOrderMarginFitInput = {
  side: "buy",
  increasingBaseInteger: "667",
  approvedPriceInteger: "270461",
  takesLiquidity: true,
  bookLevels: [{ priceInteger: "269115", sizeInteger: "125682" }],
  markPrice: "2690.88",
  sizeDecimals: 4,
  priceDecimals: 2,
  initialMarginFraction: 477,
  exchangeTakerFeePercent: "0.0000",
  exchangeAccountTakerFeeTicks: 350,
  vexIntegratorTakerFeeTicks: 1000,
  availableBalance: "8.792317",
};

describe("assessLighterOrderMarginFit", () => {
  it("refuses the 06:48 ETH buy and names the largest size that fits", () => {
    const fit = assessLighterOrderMarginFit(ETH_BUY_0648);

    expect(fit).toEqual({
      fits: false,
      // 667 x 2690.88 x 4.77%, rounded up.
      initialMarginUnits: "8561277",
      // 667 x 2691.15 x (0.035% tier + 0.1% Vex), rounded up.
      feeUnits: "242325",
      // Filling at 2691.15 against a 2690.88 mark.
      markGapUnits: "18009",
      releasedMarginUnits: "0",
      requiredUnits: "8821611",
      availableUnits: "8792317",
      maxIncreasingBaseInteger: "664",
    });
  });

  it("shows why the old sizing sent it: without the tier and the mark it looked like it fit", () => {
    const fit = assessLighterOrderMarginFit({
      ...ETH_BUY_0648,
      exchangeAccountTakerFeeTicks: 0,
      markPrice: null,
      bookLevels: null,
    });

    expect(fit.fits).toBe(true);
    expect(fit.requiredUnits).toBe("8785359");
  });

  it("admits the 06:46 BTC buy that Lighter filled", () => {
    const fit = assessLighterOrderMarginFit({
      side: "buy",
      increasingBaseInteger: "160",
      approvedPriceInteger: "846500",
      takesLiquidity: true,
      bookLevels: [{ priceInteger: "842224", sizeInteger: "63004" }],
      markPrice: "84219.1",
      sizeDecimals: 5,
      priceDecimals: 1,
      initialMarginFraction: 667,
      exchangeTakerFeePercent: "0.0000",
      exchangeAccountTakerFeeTicks: 350,
      vexIntegratorTakerFeeTicks: 1000,
      availableBalance: "9.213933",
    });

    expect(fit.fits).toBe(true);
    expect(fit.requiredUnits).toBe("9175064");
  });

  it("refuses the 06:18 ETH short, whose margin follows a mark above its own floor", () => {
    const fit = assessLighterOrderMarginFit({
      ...ETH_BUY_0648,
      side: "sell",
      increasingBaseInteger: "699",
      approvedPriceInteger: "267895",
      bookLevels: [{ priceInteger: "269218", sizeInteger: "125682" }],
      markPrice: "2692.45",
      availableBalance: "9.213933",
    });

    expect(fit.fits).toBe(false);
    expect(fit.initialMarginUnits).toBe("8977248");
    expect(fit.markGapUnits).toBe("18873");
  });

  it("margins a short at its fill, not its floor, when the market reports no mark", () => {
    const fit = assessLighterOrderMarginFit({
      ...ETH_BUY_0648,
      side: "sell",
      increasingBaseInteger: "699",
      approvedPriceInteger: "267895",
      bookLevels: [{ priceInteger: "269218", sizeInteger: "125682" }],
      markPrice: null,
      availableBalance: "9.213933",
    });

    // 699 x 2692.18 x 4.77%, not 699 x 2678.95.
    expect(fit.initialMarginUnits).toBe("8976348");
  });

  describe("an order that first closes an opposite position", () => {
    // Account 31824 at 13:36 on 2026-09-24: a 0.00134 BTC 15x long using all
    // but 0.103463 USDG, closed by a market short.
    const flip: LighterOrderMarginFitInput = {
      side: "sell",
      increasingBaseInteger: "66",
      closingBaseInteger: "134",
      approvedPriceInteger: "828950",
      takesLiquidity: true,
      bookLevels: [{ priceInteger: "833100", sizeInteger: "5000000" }],
      markPrice: "83311.2",
      sizeDecimals: 5,
      priceDecimals: 1,
      initialMarginFraction: 667,
      exchangeTakerFeePercent: "0.0000",
      exchangeAccountTakerFeeTicks: 350,
      vexIntegratorTakerFeeTicks: 1000,
      availableBalance: "0.103463",
    };

    it("admits a flip whose new side fits once the closed position's margin is freed", () => {
      const fit = assessLighterOrderMarginFit(flip);

      expect(fit.fits).toBe(true);
      expect(fit.releasedMarginUnits).toBe("7446188");
      // Fees and the fill gap are charged on the whole 0.002 traded, not just the new 0.00066.
      expect(fit.feeUnits).toBe("224937");
      expect(fit.markGapUnits).toBe("2400");
      expect(fit.requiredUnits).toBe("0");
    });

    it("refuses a flip too large even after the freed margin, and names the largest new exposure", () => {
      const fit = assessLighterOrderMarginFit({ ...flip, increasingBaseInteger: "266" });

      expect(fit.fits).toBe(false);
      expect(fit.requiredUnits).toBe("7789726");
      expect(fit.maxIncreasingBaseInteger).toBe("130");
    });
  });

  it("walks the book, and prices size past the listed depth at the order's bound", () => {
    const walk: LighterOrderMarginFitInput = {
      side: "buy",
      increasingBaseInteger: "15",
      approvedPriceInteger: "102000",
      takesLiquidity: true,
      bookLevels: [
        { priceInteger: "100000", sizeInteger: "10" },
        { priceInteger: "101000", sizeInteger: "10" },
        { priceInteger: "103000", sizeInteger: "50" },
      ],
      markPrice: "0.1",
      sizeDecimals: 0,
      priceDecimals: 6,
      initialMarginFraction: 1_000,
      exchangeTakerFeePercent: "0.0000",
      exchangeAccountTakerFeeTicks: 0,
      vexIntegratorTakerFeeTicks: null,
      availableBalance: "1",
    };

    // 15 fills 10 at 0.100000 and 5 at 0.101000; the 0.103000 level is past the
    // bound, so 25 fills its last 5 at the bound, 0.102000.
    expect(assessLighterOrderMarginFit(walk).markGapUnits).toBe("5000");
    expect(assessLighterOrderMarginFit({ ...walk, increasingBaseInteger: "25" }).markGapUnits).toBe("20000");
  });

  it("margins a resting order at its own price, with no gap to the mark", () => {
    const fit = assessLighterOrderMarginFit({
      ...ETH_BUY_0648,
      takesLiquidity: false,
      approvedPriceInteger: "260000",
    });

    expect(fit.markGapUnits).toBe("0");
    // 667 x 2600.00 x 4.77%.
    expect(fit.initialMarginUnits).toBe("8272134");
  });

  it("charges the larger of the market fee and the account's tier", () => {
    const tierOnly = assessLighterOrderMarginFit(ETH_BUY_0648);
    const marketHigher = assessLighterOrderMarginFit({ ...ETH_BUY_0648, exchangeTakerFeePercent: "0.0500" });

    expect(Number(marketHigher.feeUnits)).toBeGreaterThan(Number(tierOnly.feeUnits));
  });

  it("leaves nothing to spend from a negative balance", () => {
    const fit = assessLighterOrderMarginFit({ ...ETH_BUY_0648, availableBalance: "-0.5" });

    expect(fit.availableUnits).toBe("0");
    expect(fit.maxIncreasingBaseInteger).toBe("0");
  });

  it("assumes an unread tier above every tier Vex moves an account onto", () => {
    expect(LIGHTER_UNREAD_EXCHANGE_FEE_TICKS.taker).toBeGreaterThan(350);
    expect(LIGHTER_UNREAD_EXCHANGE_FEE_TICKS.maker).toBeGreaterThan(120);
  });
});
