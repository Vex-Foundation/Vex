/**
 * The `tradingLimits` block the agent reads on every Lighter readiness call.
 *
 * Fixtures are the LIVE shapes probed on 2026-09-10 against
 * `api.rh.lighter.xyz`: the ETH position row on account 24226 carries
 * `initial_margin_fraction: "50.00"` (a PERCENT STRING) with `margin_mode: 0`
 * and `position: "0.0000"`, while BTC market 1 reports
 * `default_initial_margin_fraction: 5000` and `min_initial_margin_fraction:
 * 200`. Those three representations of one concept are the whole reason this
 * block exists, so the fixtures use them verbatim.
 */

import { describe, expect, it } from "vitest";

import {
  resolveLighterTradingLimits,
  LIGHTER_TRADING_LIMITS_GUIDANCE,
  type ResolveLighterTradingLimitsInput,
} from "@vex-agent/tools/protocols/lighter/trading-limits.js";
import type {
  LighterAccount,
  LighterAccountPosition,
  LighterMarketDetail,
} from "@tools/lighter/types.js";

const WALLET = "0x33ef6673bd80cb11fcc41b82bc2181e65cc4d2fa";

function market(overrides: Partial<LighterMarketDetail> = {}): LighterMarketDetail {
  return {
    symbol: "ETH",
    market_id: 0,
    market_type: "perp",
    base_asset_id: 0,
    quote_asset_id: 0,
    status: "active",
    taker_fee: "0.0000",
    maker_fee: "0.0000",
    liquidation_fee: "1.0000",
    min_base_amount: "0.0050",
    min_quote_amount: "10.000000",
    supported_size_decimals: 4,
    supported_price_decimals: 2,
    supported_quote_decimals: 6,
    order_quote_limit: "281474976.710655",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
    default_initial_margin_fraction: 5000,
    min_initial_margin_fraction: 200,
    mark_price: "2441.00",
    ...overrides,
  } as LighterMarketDetail;
}

function position(overrides: Partial<LighterAccountPosition> = {}): LighterAccountPosition {
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
    margin_set_flag: 1,
    allocated_margin: "0.000000",
    ...overrides,
  } as LighterAccountPosition;
}

function account(positions: readonly LighterAccountPosition[]): LighterAccount {
  return {
    account_index: 24226,
    l1_address: "0x33eF6673BD80cB11fcC41b82Bc2181E65cC4d2fA",
    collateral: "7.884034",
    available_balance: "7.884034",
    cross_initial_margin_requirement: "0.000000",
    positions: [...positions],
  } as LighterAccount;
}

function resolve(overrides: Partial<ResolveLighterTradingLimitsInput> = {}) {
  return resolveLighterTradingLimits({
    environment: "rhc",
    walletAddress: WALLET,
    account: account([position()]),
    marketDetails: [market()],
    perpMarketCount: 57,
    limits: null,
    ...overrides,
  });
}

describe("resolveLighterTradingLimits leverage rows", () => {
  it("derives the account's CURRENT leverage from its position row's percent string", () => {
    // The defect this closes: "50.00" and 5000 and 200 all describe leverage on
    // one market, and an agent reading only the raw row answered "max 2".
    const block = resolve();
    expect(block.leverage.perMarket).toHaveLength(1);
    expect(block.leverage.perMarket[0]).toMatchObject({
      marketId: 0,
      symbol: "ETH",
      current: {
        initialMarginFraction: 5000,
        leverageDisplay: "2.00",
        marginMode: "cross",
        source: "position_row",
      },
      // The SAME market's maximum, which was explained nowhere before.
      max: { initialMarginFraction: 200, leverageDisplay: "50.00" },
    });
  });

  it("reports an isolated row's margin mode from the wire enum", () => {
    const block = resolve({ account: account([position({ margin_mode: 1 })]) });
    expect(block.leverage.perMarket[0]?.current.marginMode).toBe("isolated");
  });

  it("reports a flat row as flat and a long row as long", () => {
    expect(resolve().leverage.perMarket[0]?.openPosition)
      .toEqual({ size: "0.0000", side: "flat" });
    expect(resolve({ account: account([position({ position: "0.0500", sign: 1 })]) })
      .leverage.perMarket[0]?.openPosition).toEqual({ size: "0.0500", side: "long" });
    expect(resolve({ account: account([position({ position: "0.0500", sign: -1 })]) })
      .leverage.perMarket[0]?.openPosition).toEqual({ size: "0.0500", side: "short" });
  });

  it("KEEPS the raw provider string when the fraction cannot be read, and never throws", () => {
    // A projection that threw would take the whole readiness answer down over
    // one malformed row, and dropping the value would hide the provider's own
    // answer from a user who could still make sense of it.
    const block = resolve({ account: account([position({ initial_margin_fraction: "not-a-number" })]) });
    expect(block.leverage.perMarket[0]?.unparsable?.rawInitialMarginFraction).toBe("not-a-number");
    expect(block.leverage.perMarket[0]?.current.leverageDisplay).toBe("unknown");
  });

  it("omits a market with no position row, COUNTING it and naming why", () => {
    // Boundedness with disclosure (rule 05): the agent can tell rows exist that
    // it is not seeing, and is told how to get the number rather than guessing.
    const block = resolve();
    expect(block.leverage.omitted.count).toBe(56);
    expect(block.leverage.omitted.reason).toMatch(/56 perpetual markets/);
    expect(block.leverage.omitted.reason).toMatch(/lighter__market_get/);
    expect(block.leverage.omitted.reason).toMatch(/rather than assuming a number/);
  });

  it("reports no omissions when every perpetual market has a row", () => {
    const block = resolve({ perpMarketCount: 1 });
    expect(block.leverage.omitted.count).toBe(0);
    expect(block.leverage.omitted.reason).toMatch(/Every perpetual market/);
  });

  it("carries the 10000 scale with the numbers so a bare 5000 cannot be misread", () => {
    const block = resolve();
    expect(block.leverage.scale).toBe(10_000);
    expect(block.leverage.scaleNote).toMatch(/5000 is 50 percent/);
  });

  it("produces an empty row list for a wallet with no Lighter account yet", () => {
    const block = resolve({ account: null, perpMarketCount: 57 });
    expect(block.accountIndex).toBeNull();
    expect(block.leverage.perMarket).toEqual([]);
    expect(block.leverage.omitted.count).toBe(57);
  });
});

describe("resolveLighterTradingLimits capital share", () => {
  it("reports the user's share and says Vex refuses rather than resizes", () => {
    const block = resolve({
      limits: {
        environment: "rhc",
        walletAddress: WALLET,
        agentCapitalSharePercent: 40,
        revision: 3,
        updatedAt: "2026-09-10T00:00:00.000Z",
      },
    });
    expect(block.agentCapitalSharePercent).toBe(40);
    expect(block.capitalShareNote).toMatch(/at most 40% of its collateral/);
    expect(block.capitalShareNote).toMatch(/refuses an order that would exceed it rather than resizing/);
  });

  it("says plainly that NO ceiling applies when the user set none", () => {
    // Absent is not zero authority here: the owner withdrew the strict option.
    const block = resolve({ limits: null });
    expect(block.agentCapitalSharePercent).toBeNull();
    expect(block.capitalShareNote).toMatch(/no Vex ceiling/);
    expect(block.capitalShareNote).toMatch(/Settings -> Lighter -> Trading setup/);
  });

  it("names the user as the only owner of both numbers, on every variant", () => {
    for (const limits of [null, {
      environment: "rhc" as const,
      walletAddress: WALLET,
      agentCapitalSharePercent: 10,
      revision: 1,
      updatedAt: "2026-09-10T00:00:00.000Z",
    }]) {
      const block = resolve({ limits });
      expect(block.source).toBe("user_settings");
      expect(block.changeableBy).toBe("user_only");
      expect(block.howToChange).toBe("Settings -> Lighter -> Trading setup");
      expect(block.leverage.note).toMatch(/Vex exposes no tool that changes it/);
    }
  });

  it("points an unresolved leverage change at Reconcile, never at a retry", () => {
    expect(resolve().unresolvedChangeGuidance).toMatch(/Settings -> Lighter -> Reconcile/);
    expect(resolve().unresolvedChangeGuidance).toMatch(/do not retry or re-apply it from a tool/);
  });
});

describe("LIGHTER_TRADING_LIMITS_GUIDANCE", () => {
  it("is ONE sentence carrying the three facts the agent needs and nothing else", () => {
    // The owner's instruction for this surface is minimal: the numbers exist,
    // the agent cannot change them, the user changes them in Settings.
    expect(LIGHTER_TRADING_LIMITS_GUIDANCE).toBe(
      "Leverage per market and the agent's capital share are set by the user in "
      + "Settings -> Lighter -> Trading setup; Vex exposes no tool to change them; "
      + "read tradingLimits for the live values.",
    );
    expect(LIGHTER_TRADING_LIMITS_GUIDANCE).not.toContain("\u2014");
  });
});
