/**
 * Derived leverage on the Lighter market and position projections.
 *
 * THE DEFECT THESE PIN: before this, the only leverage-shaped facts an agent
 * could read were `margin.defaultInitialFraction: 5000` with the note "5000 is
 * 50 percent", and a raw position row saying `initial_margin_fraction: "50.00"`.
 * `minInitialFraction: 200` was explained nowhere. Given those surfaces, "max
 * leverage 2, and only 50%" is the only coherent inference an agent can draw.
 * The derived fields below are what make 200 readable as 50x.
 *
 * Every fixture value is the live 2026-09-10 shape from `api.rh.lighter.xyz`.
 */

import { describe, expect, it } from "vitest";

import {
  projectMarketDetail,
  projectPositionRow,
} from "@vex-agent/tools/protocols/lighter/projectors.js";
import type { LighterAccountPosition, LighterMarketDetail } from "@tools/lighter/types.js";

function btcMarket(overrides: Partial<LighterMarketDetail> = {}): LighterMarketDetail {
  return {
    symbol: "BTC",
    market_id: 1,
    market_type: "perp",
    base_asset_id: 0,
    quote_asset_id: 0,
    status: "active",
    taker_fee: "0.0000",
    maker_fee: "0.0000",
    liquidation_fee: "1.0000",
    min_base_amount: "0.00020",
    min_quote_amount: "10.000000",
    supported_size_decimals: 5,
    supported_price_decimals: 1,
    supported_quote_decimals: 6,
    order_quote_limit: "281474976.710655",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
    default_initial_margin_fraction: 5000,
    min_initial_margin_fraction: 200,
    maintenance_margin_fraction: 120,
    closeout_margin_fraction: 80,
    mark_price: "77329.8",
    ...overrides,
  } as LighterMarketDetail;
}

function ethPosition(overrides: Partial<LighterAccountPosition> = {}): LighterAccountPosition {
  return {
    market_id: 0,
    symbol: "ETH",
    initial_margin_fraction: "50.00",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 1,
    position: "0.0000",
    avg_entry_price: "0.00",
    position_value: "-0.000000",
    unrealized_pnl: "0.000000",
    realized_pnl: "0.000000",
    liquidation_price: "0",
    margin_mode: 0,
    allocated_margin: "0.000000",
    ...overrides,
  } as LighterAccountPosition;
}

describe("projectMarketDetail margin", () => {
  it("derives defaultLeverage and maxLeverage while leaving the raw fractions untouched", () => {
    const margin = projectMarketDetail(btcMarket()).margin as Record<string, unknown>;
    expect(margin).toMatchObject({
      scale: 10_000,
      // The provider's own numbers, unchanged.
      defaultInitialFraction: 5000,
      minInitialFraction: 200,
      maintenanceFraction: 120,
      closeoutFraction: 80,
      // What those numbers MEAN, which is what was missing.
      defaultLeverage: "2.00",
      maxLeverage: "50.00",
    });
  });

  it("names Settings as the owner of the account's current leverage", () => {
    const margin = projectMarketDetail(btcMarket()).margin as Record<string, unknown>;
    expect(margin.note).toMatch(/per-market account setting the user changes in Settings -> Lighter/);
    expect(margin.note).toMatch(/leverage\.current/);
  });

  it.each([
    ["25x SOL", 400, "25.00"],
    ["1x, no leverage", 10_000, "1.00"],
    ["a non-round fraction", 3334, "2.99"],
  ])("renders %s", (_label, fraction, display) => {
    const margin = projectMarketDetail(
      btcMarket({ default_initial_margin_fraction: fraction }),
    ).margin as Record<string, unknown>;
    expect(margin.defaultLeverage).toBe(display);
  });

  it("degrades to null on a spot row, which carries no margin fractions at all", () => {
    const margin = projectMarketDetail(btcMarket({
      market_type: "spot",
      default_initial_margin_fraction: undefined,
      min_initial_margin_fraction: undefined,
    })).margin as Record<string, unknown>;
    expect(margin.defaultLeverage).toBeNull();
    expect(margin.maxLeverage).toBeNull();
    expect(margin.defaultInitialFraction).toBeNull();
  });

  it("degrades to null rather than throwing on a fraction outside the scale", () => {
    const margin = projectMarketDetail(
      btcMarket({ default_initial_margin_fraction: 0 }),
    ).margin as Record<string, unknown>;
    expect(margin.defaultLeverage).toBeNull();
    // The provider's value still travels; only the derivation is absent.
    expect(margin.defaultInitialFraction).toBe(0);
  });
});

describe("projectPositionRow", () => {
  it("preserves the RAW row in full and adds leverage additively", () => {
    // Rewriting the row would hide the provider's own answer; leaving it alone
    // was what made the number unreadable. Both must travel.
    const row = ethPosition();
    const projected = projectPositionRow(row);
    for (const [key, value] of Object.entries(row)) {
      expect(projected[key]).toEqual(value);
    }
    expect(projected.initial_margin_fraction).toBe("50.00");
    expect(projected.leverage).toEqual({
      initialMarginFraction: 5000,
      current: "2.00",
      marginMode: "cross",
    });
  });

  it("reads an isolated row's mode from the wire enum", () => {
    expect((projectPositionRow(ethPosition({ margin_mode: 1 })).leverage as Record<string, unknown>).marginMode)
      .toBe("isolated");
  });

  it.each([
    ["the account's default", "50.00", 5000, "2.00"],
    ["the market maximum", "2.00", 200, "50.00"],
    ["a mid setting", "10.00", 1000, "10.00"],
  ])("derives %s", (_label, percent, fraction, display) => {
    expect(projectPositionRow(ethPosition({ initial_margin_fraction: percent })).leverage)
      .toEqual({ initialMarginFraction: fraction, current: display, marginMode: "cross" });
  });

  it.each([
    ["an unparsable string", "not-a-number"],
    ["a percent above 100", "150.00"],
    ["zero", "0.00"],
    ["too many decimals", "50.000"],
  ])("yields leverage null for %s, keeping the raw value and never throwing", (_label, percent) => {
    const projected = projectPositionRow(ethPosition({ initial_margin_fraction: percent }));
    expect(projected.leverage).toBeNull();
    expect(projected.initial_margin_fraction).toBe(percent);
  });

  it("yields leverage null but keeps the row when margin_mode is out of range", () => {
    // Only the mode is unreadable, so the leverage number itself still derives;
    // an unknown mode reads as null rather than being guessed as cross.
    const projected = projectPositionRow(ethPosition({ margin_mode: 7 }));
    expect(projected.leverage).toEqual({
      initialMarginFraction: 5000,
      current: "2.00",
      marginMode: null,
    });
  });
});
