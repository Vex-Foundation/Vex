/**
 * The live order steps' sizing decisions, proven deterministically.
 *
 * NOT gated and needing no flag, no vault, no database and no network: every
 * decision under test is a pure function over provider-shaped values, so the
 * arithmetic that decides how much of the owner's money an order commits stays
 * provable on any machine and in CI.
 *
 * THE DEFECT THIS FILE EXISTS TO KEEP DEAD. Lighter states one concept in two
 * units: a MARKET's `default_initial_margin_fraction` is an integer on a 10000
 * scale (5000 is 50 percent), while a POSITION row's `initial_margin_fraction`
 * is a PERCENT STRING ("50.00"). The old sizing gate fed the percent string
 * straight into the 10000-scale divisor and under-stated the required margin by
 * 100x, and it took the FIRST position row it could parse a number out of - a
 * row that may belong to another market entirely. Both are tested here, and the
 * percent-string case is red the moment the string is divided by 10000 again.
 *
 * OWNERSHIP. The scale conversion itself belongs to
 * `src/tools/lighter/margin-fraction.ts` and is tested there; what this file
 * proves is that the harness ROUTES the percent string through that converter
 * and never applies arithmetic of its own to it. The last case below runs the
 * real converter when it is on disk, so the wiring is proven end to end rather
 * than only against a stand-in.
 */

import { describe, expect, it } from "vitest";

import {
  assertTopOfBookDepth,
  decideOrderSizing,
  findLighterPositionRow,
  LIVE_ORDER_SIZE_MULTIPLE,
  LIVE_TOP_OF_BOOK_DEPTH_MULTIPLE,
  LiveHarnessRefusal,
  positionMarginFractionConverter,
  matchFillsForClientOrderIndex,
  positionExposure,
  resolveInitialMarginFraction,
  type PositionMarginFractionConverter,
  type ResolvedInitialMarginFraction,
} from "./live/harness.js";

/**
 * A stand-in with the converter's REAL behaviour on the one shape this file
 * feeds it: the provider's percent string times 100 is the 10000-scale integer
 * ("50.00" -> 5000). It is deliberately NOT the identity and NOT a spy that
 * returns a marker, because a resolver that divided the result by 10000 would
 * still look plausible against a marker.
 */
const percentToProviderScale: PositionMarginFractionConverter = (percent) => {
  const parsed = Number(percent);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    throw new Error(`not a Lighter position margin percent: ${percent}`);
  }
  return Math.round(parsed * 100);
};

/** RHC BTC market 1, measured live 2026-09-10. */
function btcMarketDetail(): Record<string, unknown> {
  return {
    market_id: 1,
    symbol: "BTC",
    min_base_amount: "0.00020",
    min_quote_amount: "10.000000",
    supported_size_decimals: 5,
    supported_price_decimals: 1,
    last_trade_price: 77240.8,
    default_initial_margin_fraction: 5000,
    min_initial_margin_fraction: 200,
    maintenance_margin_fraction: 120,
    closeout_margin_fraction: 80,
  };
}

/** The owner's account, as the REST account read returns it (percent strings). */
function positionRows(): Record<string, unknown>[] {
  return [
    { market_id: 0, symbol: "ETH", initial_margin_fraction: "50.00", position: "0.0000", sign: 1, margin_mode: 0 },
    { market_id: 1, symbol: "BTC", initial_margin_fraction: "4.00", position: "0.00040", sign: 1, margin_mode: 0 },
  ];
}

describe("the initial margin fraction the live sizing uses", () => {
  it("converts the traded market's own position percent string to the provider's 10000 scale", () => {
    const resolved = resolveInitialMarginFraction({
      marketId: 0,
      detail: { ...btcMarketDetail(), market_id: 0, symbol: "ETH" },
      positions: positionRows(),
      convertPositionPercent: percentToProviderScale,
    });
    expect(resolved).toStrictEqual<ResolvedInitialMarginFraction>({
      initialMarginFraction: 5000,
      source: "position_row",
      providerValue: "50.00",
    });
    // The defect, stated as an assertion: 5000/10000 = 0.5 was the old answer,
    // and 0.5 as a "fraction on the 10000 scale" is a 0.005% margin.
    expect(resolved.initialMarginFraction).not.toBe(0.5);
    expect(resolved.initialMarginFraction).not.toBe(50);
  });

  it("takes the row of the traded market, never the first row it can parse", () => {
    const resolved = resolveInitialMarginFraction({
      marketId: 1,
      detail: btcMarketDetail(),
      positions: positionRows(),
      convertPositionPercent: percentToProviderScale,
    });
    // ETH's row is first in the list and would have given 5000 (2x); BTC's own
    // row says 4 percent, which is 25x.
    expect(resolved.initialMarginFraction).toBe(400);
    expect(resolved.providerValue).toBe("4.00");
  });

  it("falls back to the market's own default, on the 10000 scale and unconverted", () => {
    const resolved = resolveInitialMarginFraction({
      marketId: 3,
      detail: { ...btcMarketDetail(), market_id: 3, symbol: "SOL", default_initial_margin_fraction: 400 },
      positions: positionRows(),
      convertPositionPercent: () => {
        throw new Error("the converter must not be called for a market default");
      },
    });
    expect(resolved).toStrictEqual<ResolvedInitialMarginFraction>({
      initialMarginFraction: 400,
      source: "market_default",
      providerValue: 400,
    });
  });

  it("refuses when neither a position row nor a market default carries a number", () => {
    expect(() => resolveInitialMarginFraction({
      marketId: 7,
      detail: { symbol: "XRP", default_initial_margin_fraction: null },
      positions: [],
      convertPositionPercent: percentToProviderScale,
    })).toThrow(LiveHarnessRefusal);
  });

  it("finds a market's position row and reports its absence as absence", () => {
    expect(findLighterPositionRow(positionRows(), 1)?.["symbol"]).toBe("BTC");
    expect(findLighterPositionRow(positionRows(), 9)).toBeNull();
    expect(findLighterPositionRow(null, 1)).toBeNull();
  });
});

describe("the live order size", () => {
  const margin5000: ResolvedInitialMarginFraction = {
    initialMarginFraction: 5000,
    source: "position_row",
    providerValue: "50.00",
  };

  it("sends twice the exchange minimum, so a partial fill still leaves a closable size", () => {
    const verdict = decideOrderSizing({
      marketId: 1,
      detail: btcMarketDetail(),
      margin: margin5000,
      availableCollateralUsdg: 100,
      price: 77_240.8,
    });
    // 10 USDG / 77240.8 = 0.000129..., under min_base_amount 0.00020, so the
    // exchange minimum is the base minimum and the order is twice it.
    expect(verdict.exchangeMinimumBaseAmount).toBe("0.00020");
    expect(verdict.sizeMultiple).toBe(LIVE_ORDER_SIZE_MULTIPLE);
    expect(verdict.baseAmount).toBe("0.00040");
    expect(verdict.symbol).toBe("BTC");
    expect(verdict.initialMarginFraction).toBe(5000);
    expect(verdict.initialMarginFractionSource).toBe("position_row");
    expect(verdict.requiredMarginUsdg).toBeCloseTo(0.00040 * 77_240.8 * 0.5, 9);
  });

  it("takes the quote minimum when it is the larger of the two, rounded up to the market's tick", () => {
    const verdict = decideOrderSizing({
      marketId: 1,
      detail: { ...btcMarketDetail(), min_base_amount: "0.00001", min_quote_amount: "10.000000" },
      margin: margin5000,
      availableCollateralUsdg: 100,
      price: 77_240.8,
    });
    // 10 / 77240.8 = 0.00012947..., ceiled to 5 decimals = 0.00013; twice that
    // is 0.00026, and the notional stays at or above the quote minimum.
    expect(verdict.exchangeMinimumBaseAmount).toBe("0.00013");
    expect(verdict.baseAmount).toBe("0.00026");
    expect(verdict.notionalUsdg).toBeGreaterThanOrEqual(10);
  });

  it("refuses when the account's collateral cannot carry the margin, naming both numbers", () => {
    expect(() => decideOrderSizing({
      marketId: 1,
      detail: btcMarketDetail(),
      margin: margin5000,
      availableCollateralUsdg: 1,
      price: 77_240.8,
    })).toThrow(LiveHarnessRefusal);
    expect(() => decideOrderSizing({
      marketId: 1,
      detail: btcMarketDetail(),
      margin: margin5000,
      availableCollateralUsdg: 1,
      price: 77_240.8,
    })).toThrow(/15\.448160 USDG of margin, and the account has 1\.000000 USDG available/);
  });

  it("a percent string that reached it unconverted is refused rather than sized against", () => {
    // 50 is a plausible-looking number and a catastrophic fraction: at 50/10000
    // the same order claims to need 0.5% margin instead of 50%. It is in range,
    // so this case is caught by the SOURCE contract (the resolver converts), not
    // by a bounds check; what the bounds check catches is the other direction.
    expect(() => decideOrderSizing({
      marketId: 1,
      detail: btcMarketDetail(),
      margin: { initialMarginFraction: 50_000, source: "position_row", providerValue: "50.00" },
      availableCollateralUsdg: 1_000,
      price: 77_240.8,
    })).toThrow(/not a provider fraction on the 10000 scale/);
    expect(() => decideOrderSizing({
      marketId: 1,
      detail: btcMarketDetail(),
      margin: { initialMarginFraction: 0, source: "market_default", providerValue: 0 },
      availableCollateralUsdg: 1_000,
      price: 77_240.8,
    })).toThrow(/not a provider fraction on the 10000 scale/);
  });
});

describe("the top-of-book depth gate", () => {
  const book = {
    asks: [{ price: "77250.0", remainingBaseAmount: "0.00500" }, { price: "77260.0", remainingBaseAmount: "1.0" }],
    bids: [{ price: "77240.0", remainingBaseAmount: "0.00090" }],
  };

  it("sums every level inside the IOC's own crossing band, not only the best one", () => {
    // 77260 is inside 77250 x 1.005 = 77636.25, so the order may fill there too.
    const depth = assertTopOfBookDepth({ book, side: "asks", baseAmount: "0.00040", marketId: 1 });
    expect(depth.price).toBe("77250.0");
    expect(depth.remainingBaseAmount).toBeCloseTo(1.005, 9);
    expect(depth.requiredBaseAmount).toBeCloseTo(0.0004 * LIVE_TOP_OF_BOOK_DEPTH_MULTIPLE, 9);
  });

  it("passes the measured RHC case: a thin best ask backed by deeper levels inside the band", () => {
    // Measured live 2026-09-10 on BTC (market 1): best ask 0.00025, the order was
    // 0.00040 at 3x, and the top-level-only gate refused a fill the limit price
    // already admitted.
    const thinTop = {
      asks: [
        { price: "77240.8", remainingBaseAmount: "0.00025" },
        { price: "77241.0", remainingBaseAmount: "0.00100" },
        { price: "77245.0", remainingBaseAmount: "0.00200" },
      ],
      bids: [],
    };
    const depth = assertTopOfBookDepth({ book: thinTop, side: "asks", baseAmount: "0.00040", marketId: 1 });
    expect(depth.remainingBaseAmount).toBeCloseTo(0.00325, 9);
  });

  it("stops summing at the band edge, so depth past the limit price never counts", () => {
    const farLevel = {
      asks: [
        { price: "77250.0", remainingBaseAmount: "0.00050" },
        { price: "78000.0", remainingBaseAmount: "5.0" },
      ],
      bids: [],
    };
    expect(() => assertTopOfBookDepth({ book: farLevel, side: "asks", baseAmount: "0.00040", marketId: 1 }))
      .toThrow(/hold 0\.0005 base units across 1 level\(s\)/);
  });

  it("refuses a thin side rather than letting the order walk the book", () => {
    expect(() => assertTopOfBookDepth({ book, side: "bids", baseAmount: "0.00040", marketId: 1 }))
      .toThrow(/hold 0\.0009 base units across 1 level\(s\) inside the 1\.005x crossing band, and this run requires at least 0\.0012/);
  });

  it("refuses an empty side rather than treating an unmeasurable book as deep enough", () => {
    expect(() => assertTopOfBookDepth({ book: { asks: [], bids: [] }, side: "asks", baseAmount: "0.1", marketId: 1 }))
      .toThrow(LiveHarnessRefusal);
    expect(() => assertTopOfBookDepth({ book: null, side: "asks", baseAmount: "0.1", marketId: 1 }))
      .toThrow(LiveHarnessRefusal);
  });
});

describe("matching a fill to the run that caused it", () => {
  const trades = [
    // An earlier run's fill on the same market: same account, different order.
    { market_id: 1, size: "0.00100", bid_client_id_str: "111", ask_client_id_str: "999" },
    { market_id: 1, size: "0.00025", bid_client_id_str: "222", ask_client_id_str: "888" },
    { market_id: 1, size: "0.00015", bid_client_id_str: "222", ask_client_id_str: "777" },
    // The same client id on ANOTHER market must not count towards this market.
    { market_id: 0, size: "5.0", bid_client_id_str: "222", ask_client_id_str: "666" },
  ];

  it("sums only this run's own fills on the traded market", () => {
    const matched = matchFillsForClientOrderIndex({
      trades,
      marketId: 1,
      side: "buy",
      clientOrderIndex: "222",
    });
    expect(matched.trades).toHaveLength(2);
    expect(matched.filledBase).toBeCloseTo(0.0004, 9);
  });

  it("reads our side from the ask id on a sell", () => {
    expect(matchFillsForClientOrderIndex({
      trades,
      marketId: 1,
      side: "sell",
      clientOrderIndex: "888",
    }).filledBase).toBeCloseTo(0.00025, 9);
  });

  it("reports zero when nothing in the account's history belongs to this run", () => {
    expect(matchFillsForClientOrderIndex({
      trades,
      marketId: 1,
      side: "buy",
      clientOrderIndex: "does-not-exist",
    }).filledBase).toBe(0);
  });
});

describe("the exposure the close step has to bring to zero", () => {
  it("reports an absent row as no exposure and a short as a negative signed size", () => {
    expect(positionExposure(positionRows(), 9)).toStrictEqual({ size: 0, signedSize: 0, row: null });
    const short = positionExposure([{ market_id: 1, position: "0.00040", sign: -1 }], 1);
    expect(short.size).toBe(0.0004);
    expect(short.signedSize).toBe(-0.0004);
  });

  it("refuses an unreadable position rather than reporting it as closed", () => {
    expect(() => positionExposure([{ market_id: 1, position: "n/a", sign: 1 }], 1))
      .toThrow(LiveHarnessRefusal);
  });
});

// ── The wiring, against the real converter ──────────────────────────────

describe("the resolver against the repository's own margin-fraction converter", () => {
  it("converts the owner's live percent string to 5000, through the repository's function", () => {
    // Not the stand-in above: `positionMarginFractionConverter` IS
    // `positionInitialMarginFractionToProviderScale`, so this case proves the
    // harness and the repository agree on the unit.
    expect(resolveInitialMarginFraction({
      marketId: 0,
      detail: { symbol: "ETH", default_initial_margin_fraction: 5000 },
      positions: positionRows(),
      convertPositionPercent: positionMarginFractionConverter,
    })).toStrictEqual<ResolvedInitialMarginFraction>({
      initialMarginFraction: 5000,
      source: "position_row",
      providerValue: "50.00",
    });
  });

  it("refuses a percent the repository's converter will not accept, rather than sizing against it", () => {
    // The converter is the gate on the shape, and the resolver does not soften
    // it: a row whose percent is malformed stops the sizing instead of
    // producing a number nobody checked.
    expect(() => resolveInitialMarginFraction({
      marketId: 0,
      detail: { symbol: "ETH", default_initial_margin_fraction: 5000 },
      positions: [{ market_id: 0, initial_margin_fraction: "not-a-percent" }],
      convertPositionPercent: positionMarginFractionConverter,
    })).toThrow();
  });
});
