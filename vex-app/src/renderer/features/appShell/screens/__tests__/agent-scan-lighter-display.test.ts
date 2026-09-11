/**
 * Lighter fill display readers - the pure formatters behind the Agent Scan
 * feed's second arm.
 *
 * Pins, each one a contract obligation from
 * `shared/schemas/agent-scan-lighter-entry.ts`:
 *   - MONEY IS STRING ARITHMETIC: a base-unit integer scaled by its decimals
 *     keeps every declared place, and the venue's own precision (`0.0050`)
 *     survives - a `Number` round-trip would silently rewrite both;
 *   - SETTLED IS NOT ESTIMATED: the venue's USD notional prints plain, a fee
 *     estimate prints with the `~ ... est.` marker, its basis and its tick;
 *   - UNKNOWN IS NOT ZERO: a null leverage reads `unknown`, a null account
 *     half reads "position facts unknown", an unproven charge prints nothing;
 *   - TOLERANT READER: a vocabulary value this build predates renders its own
 *     bounded text instead of blanking the row;
 *   - POSITION NOW has FOUR cases, and "no observation" is not "closed".
 */

import { describe, expect, it } from "vitest";
import type { AgentScanLighterFillEntry } from "@shared/schemas/agent-scan-lighter-entry.js";
import { lighterFill } from "./_agent-scan-fixtures.js";
import {
  LIGHTER_MAX_EXPANDED_DECIMALS,
  lighterAttentionTradeTypeText,
  lighterChargedAmountText,
  lighterUsdFullText,
  lighterDecimalText,
  lighterEffectLabel,
  lighterEntryQuoteBeforeText,
  lighterExchangeFeeText,
  lighterIntegratorFeeText,
  lighterKindLabel,
  lighterLeverageChipText,
  lighterLeverageDrawerText,
  lighterObservedAtText,
  lighterPositionBeforeText,
  lighterPositionNowLines,
  lighterRawAmountText,
  lighterRealizedPnlText,
  lighterSideLabel,
  lighterSignedDecimalText,
  lighterTradeText,
  lighterTradeTypeLabel,
  lighterUsdEstimateText,
  lighterUsdSettledText,
  lighterVenueLabel,
} from "../agent-scan/agent-scan-lighter-display.js";

const ASSETS = { base: "ETH", quote: "USDG" } as const;

/** A fixed "now" so the today/not-today branch is deterministic. */
const NOW = new Date("2026-07-20T18:00:00");

describe("lighter amounts - string arithmetic, never a float", () => {
  it.each([
    ["0.0050", "0.0050"],
    ["2598.09", "2,598.09"],
    ["1234567.5", "1,234,567.5"],
    ["-1234.5", "-1,234.5"],
    ["18412771", "18,412,771"],
  ])("groups %s as %s and keeps the venue's own precision", (input, expected) => {
    expect(lighterDecimalText(input)).toBe(expected);
  });

  it.each([
    ["12990", 6, "0.012990"],
    ["4546", 6, "0.004546"],
    ["1000000000000000000", 18, "1.000000000000000000"],
    ["12", 0, "12"],
    ["-4546", 6, "-0.004546"],
  ])("scales raw %s at %i decimals to %s", (raw, decimals, expected) => {
    expect(lighterRawAmountText(raw, decimals as number)).toBe(expected);
  });

  it("refuses a raw value that is not an integer rather than printing a guess", () => {
    expect(lighterRawAmountText("12.5", 6)).toBeNull();
    expect(lighterRawAmountText("garbage", 6)).toBeNull();
  });

  it("scales ANY decimals count - a 37-decimal asset is no reason to hide an amount", () => {
    // The ledger and the contract put no upper bound on decimals; a cap here
    // made a recorded charge vanish from the drawer (final review, 2026-09-11).
    expect(lighterRawAmountText("123", 37)).toBe(`0.${"0".repeat(34)}123`);
    expect(lighterRawAmountText("1", 60)).toBe(`0.${"0".repeat(59)}1`);
  });

  it.each([
    ["0.0050", "+0.0050"],
    ["-0.0050", "-0.0050"],
    ["0", "0"],
    ["0.00", "0.00"],
  ])("signs %s as %s - zero takes no sign", (input, expected) => {
    expect(lighterSignedDecimalText(input)).toBe(expected);
  });
});

describe("lighter USD - settled versus estimated", () => {
  it("prints the venue's SETTLED notional plain, with no estimate marker", () => {
    expect(lighterUsdSettledText("12.990450")).toBe("$12.99");
    expect(lighterUsdSettledText("12.990450")).not.toContain("est.");
    expect(lighterUsdSettledText("12.990450")).not.toContain("~");
  });

  it("TRUNCATES the cents rather than rounding a settled figure up", () => {
    expect(lighterUsdSettledText("12.999")).toBe("$12.99");
    expect(lighterUsdSettledText("1234")).toBe("$1,234.00");
    expect(lighterUsdSettledText("0.5")).toBe("$0.50");
  });

  it("marks an ESTIMATE and keeps every place it carries (a sub-cent fee is not $0.00)", () => {
    expect(lighterUsdEstimateText("0.004546")).toBe("~$0.004546 est.");
  });
});

describe("lighter labels", () => {
  it("names the market kind from `spot`", () => {
    expect(lighterKindLabel(false)).toBe("PERP");
    expect(lighterKindLabel(true)).toBe("SPOT");
  });

  it.each([
    ["open", "OPEN"],
    ["increase", "INCREASE"],
    ["reduce", "REDUCE"],
    ["close", "CLOSE"],
    ["flip", "FLIP"],
  ])("labels the %s effect as %s", (effect, expected) => {
    expect(lighterEffectLabel(effect)).toBe(expected);
  });

  it("reads a NULL and an `unknown` effect the same way - we do not know", () => {
    expect(lighterEffectLabel(null)).toBe("UNKNOWN");
    expect(lighterEffectLabel("unknown")).toBe("UNKNOWN");
  });

  it("keeps an effect this build predates readable instead of blanking it", () => {
    expect(lighterEffectLabel("reopen_after_settlement")).toBe("REOPEN_AFTER_SETTLEMENT");
  });

  it.each([
    ["buy", "Buy"],
    ["sell", "Sell"],
  ])("labels the %s side", (side, expected) => {
    expect(lighterSideLabel(side)).toBe(expected);
  });

  it.each([
    ["core", "Lighter Core"],
    ["rhc", "Lighter on Robinhood Chain"],
    ["staging", "staging"],
  ])("names the %s venue", (environment, expected) => {
    expect(lighterVenueLabel(environment)).toBe(expected);
  });

  it.each([
    ["trade", "Trade"],
    ["liquidation", "Liquidation"],
    ["deleverage", "Deleverage"],
    ["market-settlement", "Market settlement"],
  ])("names the %s trade type", (tradeType, expected) => {
    expect(lighterTradeTypeLabel(tradeType)).toBe(expected);
  });

  it("raises an attention chip ONLY for a fill the user did not place", () => {
    expect(lighterAttentionTradeTypeText("liquidation")).toBe("liquidation");
    expect(lighterAttentionTradeTypeText("deleverage")).toBe("deleverage");
    expect(lighterAttentionTradeTypeText("market-settlement")).toBe("market settlement");
    expect(lighterAttentionTradeTypeText("trade")).toBeNull();
  });

  it("writes the executed trade as one sentence", () => {
    expect(lighterTradeText(lighterFill({ id: "1" }))).toBe("Buy 0.0050 ETH @ 2,598.09");
  });
});

describe("lighter leverage - absent is not 1x", () => {
  it("renders the chip only when the fraction is on the row", () => {
    expect(lighterLeverageChipText({ initialMarginFraction: 1000, display: "10.00" }))
      .toBe("10.00x");
    expect(lighterLeverageChipText(null)).toBeNull();
  });

  it("says `unknown` in the drawer - never 0x, never the current setting", () => {
    expect(lighterLeverageDrawerText(null)).toBe("unknown");
    expect(lighterLeverageDrawerText({ initialMarginFraction: 3334, display: "2.99" }))
      .toBe("2.99x");
  });
});

describe("lighter position facts", () => {
  it("states the position before the fill, signed, in the base asset", () => {
    const fill = lighterFill({ id: "1", positionSizeBefore: "-0.0120" });
    expect(lighterPositionBeforeText(fill)).toBe("-0.0120 ETH");
  });

  it("says the facts are UNKNOWN on a public row - never 0", () => {
    const fill = lighterFill({
      id: "1",
      positionSizeBefore: null,
      entryQuoteBefore: null,
      accountPnl: null,
      positionEffect: null,
    });
    expect(lighterPositionBeforeText(fill)).toBe("position facts unknown");
    expect(lighterPositionBeforeText(fill)).not.toContain("0");
    expect(lighterEntryQuoteBeforeText(fill)).toBeNull();
    expect(lighterRealizedPnlText(fill)).toBeNull();
  });

  it("shows the entry quote before the fill when the ledger carries it", () => {
    const fill = lighterFill({ id: "1", entryQuoteBefore: "-12.990450" });
    expect(lighterEntryQuoteBeforeText(fill)).toBe("-12.990450 USDG");
  });

  it.each(["reduce", "close", "flip"])(
    "shows realized PnL on a %s fill",
    (effect) => {
      const fill = lighterFill({ id: "1", positionEffect: effect, accountPnl: "-0.4412" });
      expect(lighterRealizedPnlText(fill)).toBe("-0.4412 USDG");
    },
  );

  it.each(["open", "increase"])(
    "shows NO realized PnL on a %s fill - a 0 there would read as a result",
    (effect) => {
      const fill = lighterFill({ id: "1", positionEffect: effect, accountPnl: "0" });
      expect(lighterRealizedPnlText(fill)).toBeNull();
    },
  );
});

describe("lighter fees - provenance intact", () => {
  it("prints the CHARGED integrator amount in its own asset when proven", () => {
    const fill = lighterFill({
      id: "1",
      integratorFee: {
        charged: { raw: "12990", symbol: "USDG", decimals: 6 },
        estimate: null,
        tickObserved: 1000,
        tickAuthorized: 1000,
      },
    });
    const text = lighterIntegratorFeeText(fill.integratorFee);
    expect(text).toBe("0.012990 USDG");
    expect(text).not.toContain("est.");
  });

  it("prints the ESTIMATE with the marker, the basis and the tick it used", () => {
    const fill = lighterFill({ id: "1" });
    expect(lighterIntegratorFeeText(fill.integratorFee)).toBe(
      "~ 0.012990 USDG est., on quote notional, observed tick · ~$0.012990 est.",
    );
  });

  it("names an AUTHORIZED tick as its own source", () => {
    const fill = lighterFill({
      id: "1",
      integratorFee: {
        charged: null,
        estimate: {
          raw: "12990",
          symbol: "USDG",
          decimals: 6,
          basis: "received_base",
          tickSource: "authorized",
          usd: null,
        },
        tickObserved: null,
        tickAuthorized: 1000,
      },
    });
    expect(lighterIntegratorFeeText(fill.integratorFee)).toBe(
      "~ 0.012990 USDG est., on the received base, authorized tick",
    );
  });

  it("says NOTHING when neither a charge nor an estimate is recorded - never 0", () => {
    const fill = lighterFill({
      id: "1",
      integratorFee: {
        charged: null,
        estimate: null,
        tickObserved: null,
        tickAuthorized: null,
      },
    });
    expect(lighterIntegratorFeeText(fill.integratorFee)).toBeNull();
  });

  it("calls a NEGATIVE charged exchange fee a rebate, in words", () => {
    const fill = lighterFill({
      id: "1",
      exchangeFee: {
        charged: { raw: "-4546", symbol: "USDG", decimals: 6 },
        estimatedUsd: null,
        tickObserved: 350,
      },
    });
    expect(lighterExchangeFeeText(fill.exchangeFee)).toBe(
      "0.004546 USDG rebate (paid to this account)",
    );
  });

  it("falls back to the exchange fee's USD estimate, marked as one", () => {
    const fill = lighterFill({ id: "1" });
    expect(lighterExchangeFeeText(fill.exchangeFee)).toBe("~$0.004546 est.");
  });

  it("never trades a RECORDED charge for an estimate: a 37-decimal asset still prints the charge", () => {
    const integrator = lighterIntegratorFeeText({
      charged: { raw: "123", symbol: "ASSET", decimals: 37 },
      estimate: null,
      tickObserved: null,
      tickAuthorized: null,
    });
    expect(integrator).toBe(`0.${"0".repeat(34)}123 ASSET`);
    const exchange = lighterExchangeFeeText({
      charged: { raw: "123", symbol: "ASSET", decimals: 37 },
      estimatedUsd: "0.01",
      tickObserved: 350,
    });
    expect(exchange).toBe(`0.${"0".repeat(34)}123 ASSET`);
    expect(exchange).not.toContain("est.");
  });

  it("states a charge it cannot scale in raw units rather than falling through to the estimate", () => {
    // Unreachable through the validated contract (the DTO refuses a non-integer
    // raw), pinned so the fallback can never silently become "use the estimate".
    const unscalable = { raw: "12.5", symbol: "USDG", decimals: 6 };
    expect(lighterChargedAmountText(unscalable)).toBe("12.5 raw units at 6 decimals, USDG");
    expect(
      lighterExchangeFeeText({ charged: unscalable, estimatedUsd: "0.01", tickObserved: null }),
    ).toBe("12.5 raw units at 6 decimals, USDG");
  });

  it("bounds the expanded text: an absurd decimals count states raw units and never throws", () => {
    // The ledger's INTEGER admits two billion; padding to it threw a
    // RangeError inside the row (final review round 2). Above the bound the
    // charge is stated in raw units, with the estimate marker kept on an
    // estimate; nothing throws and nothing falls through to another figure.
    const absurd = 2_147_483_647;
    expect(lighterRawAmountText("123", absurd)).toBeNull();
    expect(lighterRawAmountText("123", LIGHTER_MAX_EXPANDED_DECIMALS)).not.toBeNull();
    expect(
      lighterIntegratorFeeText({
        charged: { raw: "123", symbol: "ASSET", decimals: absurd },
        estimate: null,
        tickObserved: null,
        tickAuthorized: null,
      }),
    ).toBe(`123 raw units at ${absurd} decimals, ASSET`);
    expect(
      lighterExchangeFeeText({
        charged: { raw: "-123", symbol: "ASSET", decimals: absurd },
        estimatedUsd: "0.01",
        tickObserved: null,
      }),
    ).toBe(`123 raw units at ${absurd} decimals, ASSET rebate (paid to this account)`);
    expect(
      lighterIntegratorFeeText({
        charged: null,
        estimate: {
          raw: "123",
          symbol: "ASSET",
          decimals: absurd,
          basis: "quote_notional",
          tickSource: "observed",
          usd: null,
        },
        tickObserved: null,
        tickAuthorized: null,
      }),
    ).toBe(`~ 123 raw units at ${absurd} decimals ASSET est., on quote notional, observed tick`);
  });

  it("prints the settled USD whole for the drawer, with no cents cut", () => {
    expect(lighterUsdFullText("12.990450")).toBe("$12.990450");
    expect(lighterUsdFullText("1234567.5")).toBe("$1,234,567.5");
  });
});

describe("lighter observation time", () => {
  it("prints the clock alone for an observation made TODAY", () => {
    expect(lighterObservedAtText("2026-07-20T16:49:00", NOW)).toBe("16:49");
  });

  it("adds the DATE the moment the observation is not today's", () => {
    expect(lighterObservedAtText("2026-06-12T16:49:00", NOW)).toBe("Jun 12 · 16:49");
  });

  it("returns null for an unparseable timestamp rather than a fabricated time", () => {
    expect(lighterObservedAtText("not-a-date", NOW)).toBeNull();
  });
});

describe("lighter position now - four cases", () => {
  function positionNowOf(
    overrides: Partial<AgentScanLighterFillEntry>,
  ): readonly string[] | null {
    return lighterPositionNowLines(
      lighterFill({ id: "1", ...overrides }).positionNow,
      ASSETS,
      NOW,
    );
  }

  it("renders NO block when nothing was ever observed - absence is not `closed`", () => {
    expect(positionNowOf({ positionNow: null })).toBeNull();
  });

  it("states a market observed CLOSED, with when it was observed", () => {
    expect(
      positionNowOf({
        positionNow: {
          observedAt: "2026-07-20T16:49:00",
          open: false,
          position: null,
        },
      }),
    ).toEqual(["closed (last observed 16:49)"]);
  });

  it("states an OPEN position whose stored details could not be read", () => {
    expect(
      positionNowOf({
        positionNow: {
          observedAt: "2026-07-20T16:49:00",
          open: true,
          position: null,
        },
      }),
    ).toEqual(["open, details unavailable (last observed 16:49)"]);
  });

  it("states every observed figure of an OPEN position, as facts about THEN", () => {
    expect(
      positionNowOf({
        positionNow: {
          observedAt: "2026-07-20T16:49:00",
          open: true,
          position: {
            size: "0.0050",
            entryPrice: "2598.09",
            unrealizedPnl: "-0.0077",
            realizedPnl: "0",
            liquidationPrice: "2365.93",
            leverage: { initialMarginFraction: 1000, display: "10.00" },
            marginMode: "isolated",
          },
        },
      }),
    ).toEqual([
      "+0.0050 ETH (last observed 16:49)",
      "entry 2,598.09",
      "unrealized PnL -0.0077 USDG",
      "realized PnL 0 USDG",
      "liquidation 2,365.93",
      "isolated",
      "10.00x",
    ]);
  });

  it("omits each fact the observation lacks, without discarding the ones beside it", () => {
    expect(
      positionNowOf({
        positionNow: {
          observedAt: "2026-07-20T16:49:00",
          open: true,
          position: {
            size: "-0.0050",
            entryPrice: null,
            unrealizedPnl: null,
            realizedPnl: null,
            liquidationPrice: null,
            leverage: null,
            marginMode: null,
          },
        },
      }),
    ).toEqual(["-0.0050 ETH (last observed 16:49)"]);
  });
});
