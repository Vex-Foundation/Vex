/**
 * WHAT A HUMAN AND AN AGENT SEE ON A LIGHTER TRADE, and the four ways getting
 * it wrong misreports the account.
 *
 *   1. THE ACCOUNT'S SIDE. A trade record names both parties. Reading the
 *      maker's "before" fields when the account was the taker, or the ask PnL
 *      when the account was the bidder, reports a STRANGER'S position and a
 *      stranger's realized profit as the user's own.
 *   2. FEE TICKS ARE NOT AMOUNTS. `taker_fee: 350` beside a notional of 0.74
 *      USD is a rate in millionths, measured live 2026-09-08. Projected as an
 *      amount it claims a 350 dollar fee on a 74 cent trade.
 *   3. ABSENT IS NOT UNKNOWN. A public tape row cannot say what a position did;
 *      a row whose fields contradict each other can, and says something
 *      impossible. The projection keeps `known: false` and an effect of
 *      "unknown" as different statements.
 *   4. MARGIN SCALE. The provider's fractions are on a 10000 scale. A bare
 *      5000 read as a percentage is a 5000 percent margin requirement.
 *
 * The trade fixture is the live public Core row of 2026-09-08 plus the fields
 * an authenticated read adds, so every optional field the projection reads is
 * present in a fixture at least once (rule 10 item 3).
 */

import { describe, it, expect } from "vitest";

import type { LighterMarketDetail, LighterTrade } from "@tools/lighter/types.js";
import {
  classifyLighterPositionEffect,
  lighterCampaignTradeType,
  readLighterAccountFillFacts,
  type LighterPositionEffect,
} from "@vex-agent/tools/protocols/lighter/fill-position-effect.js";
import {
  projectMarketDetail,
  projectTrade,
} from "@vex-agent/tools/protocols/lighter/projectors.js";

const ASK_ACCOUNT = 737624;
const BID_ACCOUNT = 702384;

/** VERBATIM from the live public Core tape (recentTrades, market 1), 2026-09-08. */
const PUBLIC_TRADE: LighterTrade = {
  trade_id: 29748467352,
  trade_id_str: "29748467352",
  tx_hash: "b96029f761027daa20466fdf3ba7c1d269b1871a3f857aab91fab6d4bac4266ca92944d5edba1ae9",
  type: "trade",
  market_id: 1,
  size: "0.02000",
  price: "78354.1",
  usd_amount: "1567.082000",
  ask_id: 562953293892152,
  ask_id_str: "562953293892152",
  bid_id: 844421545413234,
  bid_id_str: "844421545413234",
  ask_client_id: 223126120761038,
  ask_client_id_str: "223126120761038",
  bid_client_id: 230078951108215,
  bid_client_id_str: "230078951108215",
  ask_account_id: ASK_ACCOUNT,
  bid_account_id: BID_ACCOUNT,
  is_maker_ask: false,
  block_height: 328303571,
  timestamp: 1788858716527,
  taker_position_size_before: "0.00000",
  taker_entry_quote_before: "0.000000",
  taker_initial_margin_fraction_before: 500,
  taker_position_sign_changed: true,
  maker_fee: 28,
  maker_position_size_before: "14.07123",
  maker_entry_quote_before: "1103252.791990",
  maker_initial_margin_fraction_before: 3333,
  transaction_time: 1788858716531726,
  ask_order_version: 0,
  bid_order_version: 0,
};

/** The same record as an authenticated read returns it for the account. */
const AUTHENTICATED_TRADE: LighterTrade = {
  ...PUBLIC_TRADE,
  taker_fee: 350,
  maker_position_sign_changed: false,
  ask_account_pnl: "1.989696",
  bid_account_pnl: "-0.022890",
  integrator_taker_fee: 1000,
  integrator_taker_fee_collector_index: 743799,
  integrator_maker_fee: 2500,
  integrator_maker_fee_collector_index: 743799,
  taker_allocated_margin_usdc_before: 1100000000000000,
  taker_allocated_margin_usdc_after: 150000000000000,
  maker_allocated_margin_usdc_before: 210000000000000,
  maker_allocated_margin_usdc_after: 250000000000000,
};

function account(projected: Record<string, unknown>): Record<string, unknown> {
  return projected.account as Record<string, unknown>;
}

function fees(projected: Record<string, unknown>): Record<string, unknown> {
  return projected.fees as Record<string, unknown>;
}

describe("projectTrade without an account", () => {
  const projected = projectTrade(PUBLIC_TRADE);

  it("keeps Lighter's own USD notional and its trade type", () => {
    expect(projected.usdAmount).toBe("1567.082000");
    expect(projected.type).toBe("trade");
  });

  it("reads the timestamp as milliseconds, the unit measured live", () => {
    // 1788858716527 as seconds would date this fill to the year 58656.
    expect(projected.tradedAt).toBe("2026-09-08T09:11:56.527Z");
    expect(projected.timestampUnit).toBe("epoch_milliseconds");
    expect(projected.transactionTimeUnit).toBe("epoch_microseconds");
  });

  it("names the fee ticks as rates, never as amounts", () => {
    expect(fees(projected).unit).toBe("rate_tick_millionths_of_notional");
    expect(fees(projected).exchangeMakerTick).toBe(28);
    // The public row carries no taker fee and no integrator terms at all.
    expect(fees(projected).exchangeTakerTick).toBeNull();
    expect(fees(projected).integratorTakerTick).toBeNull();
  });

  it("reports no account view at all, which is not an effect of unknown", () => {
    expect(account(projected).known).toBe(false);
    expect(account(projected).side).toBeNull();
    expect(account(projected).realizedPnl).toBeNull();
    expect(account(projected).positionEffect).toBe("unknown");
    expect(account(projected).campaignType).toBe("unknown");
  });
});

describe("projectTrade for one account", () => {
  it("takes the taker half and the bid PnL when the account bought as taker", () => {
    // `is_maker_ask: false` makes the ASK the taker... and the bidder the
    // maker. The bidder is the buyer, so this account is the maker on the buy
    // side, and its own fields are the MAKER ones.
    const view = account(projectTrade(AUTHENTICATED_TRADE, BID_ACCOUNT));
    expect(view.side).toBe("buy");
    expect(view.role).toBe("maker");
    expect(view.positionSizeBefore).toBe("14.07123");
    expect(view.entryQuoteBefore).toBe("1103252.791990");
    expect(view.initialMarginFractionBefore).toBe(3333);
    expect(view.marginFractionScale).toBe(10_000);
    expect(view.realizedPnl).toBe("-0.022890");
    expect(view.known).toBe(true);
  });

  it("takes the taker half and the ask PnL when the account sold as taker", () => {
    const view = account(projectTrade(AUTHENTICATED_TRADE, ASK_ACCOUNT));
    expect(view.side).toBe("sell");
    expect(view.role).toBe("taker");
    expect(view.positionSizeBefore).toBe("0.00000");
    expect(view.realizedPnl).toBe("1.989696");
    // Flat before, sold, and the provider says the sign changed: a flip out of
    // nothing is not possible, so the flat position decides it - an open.
    expect(view.positionEffect).toBe("open");
    expect(view.campaignType).toBe("open");
  });

  it("keeps the side and role but no knowledge when the row is the public one", () => {
    const view = account(projectTrade(PUBLIC_TRADE, ASK_ACCOUNT));
    expect(view.side).toBe("sell");
    expect(view.role).toBe("taker");
    // The public row has the taker's size and flag but no realized PnL, and
    // three of four fields is not a classification.
    expect(view.known).toBe(false);
    expect(view.positionSizeBefore).toBeNull();
    expect(view.positionEffect).toBe("unknown");
  });

  it("reports nothing for an account that is on neither side", () => {
    expect(account(projectTrade(AUTHENTICATED_TRADE, 999_999)).known).toBe(false);
  });

  it("reports nothing when the account is its own counterparty", () => {
    const selfTrade: LighterTrade = {
      ...AUTHENTICATED_TRADE,
      ask_account_id: BID_ACCOUNT,
    };
    // There is no single side to report, so no side is guessed.
    expect(account(projectTrade(selfTrade, BID_ACCOUNT)).known).toBe(false);
    expect(account(projectTrade(selfTrade, BID_ACCOUNT)).side).toBeNull();
  });
});

describe("readLighterAccountFillFacts", () => {
  it("returns nothing while the realized PnL for the account's side is absent", () => {
    expect(readLighterAccountFillFacts({ trade: PUBLIC_TRADE, role: "taker", side: "sell" })).toBeNull();
  });

  it("returns the whole half once every field is present", () => {
    const facts = readLighterAccountFillFacts({
      trade: AUTHENTICATED_TRADE,
      role: "maker",
      side: "buy",
    });
    expect(facts).toEqual({
      positionSizeBefore: "14.07123",
      positionSignChanged: false,
      entryQuoteBefore: "1103252.791990",
      accountPnl: "-0.022890",
      initialMarginFractionBefore: 3333,
    });
  });

  it("treats a realized PnL of zero as knowledge, not as absence", () => {
    const facts = readLighterAccountFillFacts({
      trade: { ...AUTHENTICATED_TRADE, bid_account_pnl: "0" },
      role: "maker",
      side: "buy",
    });
    expect(facts?.accountPnl).toBe("0");
  });
});

describe("the position effect, over the cross product of Lighter's own fields", () => {
  interface EffectCase {
    readonly before: string;
    readonly signChanged: boolean;
    readonly fill: string;
    readonly side: "buy" | "sell";
    readonly expected: LighterPositionEffect;
    readonly why: string;
  }

  const EFFECT_CASES: readonly EffectCase[] = ([

    // before, signChanged, fill size, side, expected, why
    ["0", false, "1", "buy", "open", "flat, bought"],
    ["0", false, "1", "sell", "open", "flat, sold short"],
    ["0.00000", true, "0.02", "sell", "open", "flat: a flip out of nothing is still an open"],
    ["2.5", false, "1", "buy", "increase", "long, bought more"],
    ["-2.5", false, "1", "sell", "increase", "short, sold more"],
    ["2.5", false, "1", "sell", "reduce", "long, sold part"],
    ["-2.5", false, "1", "buy", "reduce", "short, bought part"],
    // MEASURED 2026-09-08 on a live close (RHC, a 0.0050 long sold whole):
    // Lighter reports position_sign_changed TRUE when the position goes to
    // zero, so a close carries the flag and a whole-size fill without it is a
    // contradiction, not a close.
    ["2.5", true, "2.5", "sell", "close", "long, sold exactly the position"],
    ["-2.5", true, "2.50000", "buy", "close", "close survives trailing zeros"],
    ["2.5", false, "2.5", "sell", "unknown", "sold exactly the position, yet no sign change reported"],
    ["2.5", true, "4", "sell", "flip", "long carried through zero into a short"],
    ["-2.5", true, "4", "buy", "flip", "short carried through zero into a long"],
    ["2.5", false, "4", "sell", "unknown", "bigger than the position, yet no sign change reported"],
    ["2.5", true, "1", "sell", "unknown", "a partial reduce said to have changed sign"],
    ["2.5", true, "1", "buy", "unknown", "an increase said to have changed sign"],
    ["2.5", false, "0", "sell", "unknown", "a zero-size fill moves nothing"],
    ["0", false, "0", "buy", "unknown", "nothing held and nothing traded"],
  ] as const).map(([before, signChanged, fill, side, expected, why]) => ({
    before,
    signChanged,
    fill,
    side,
    expected,
    why,
  }));

  it.each(EFFECT_CASES)(
    "$before before, signChanged=$signChanged, $fill $side -> $expected ($why)",
    ({ before, signChanged, fill, side, expected }) => {
      expect(classifyLighterPositionEffect({
        positionSizeBefore: before,
        positionSignChanged: signChanged,
        fillBaseSize: fill,
        side,
      })).toBe(expected);
    },
  );

  it("compares decimals exactly, where a double would round the answer wrong", () => {
    // 0.1 + 0.2 in doubles is 0.30000000000000004: a close read through floats
    // becomes a reduce that leaves phantom dust behind.
    expect(classifyLighterPositionEffect({
      positionSizeBefore: "0.30000000000000001",
      positionSignChanged: false,
      fillBaseSize: "0.3",
      side: "sell",
    })).toBe("reduce");
    expect(classifyLighterPositionEffect({
      positionSizeBefore: "0.3",
      positionSignChanged: true,
      fillBaseSize: "0.30",
      side: "sell",
    })).toBe("close");
  });

  it("refuses a malformed size rather than classifying it", () => {
    expect(classifyLighterPositionEffect({
      positionSizeBefore: "1e5",
      positionSignChanged: false,
      fillBaseSize: "1",
      side: "buy",
    })).toBe("unknown");
  });

  const CAMPAIGN_CASES: readonly { effect: LighterPositionEffect; expected: string }[] = [
    { effect: "open", expected: "open" },
    { effect: "increase", expected: "open" },
    { effect: "reduce", expected: "close" },
    { effect: "close", expected: "close" },
    { effect: "flip", expected: "close" },
    { effect: "unknown", expected: "unknown" },
  ];

  it.each(CAMPAIGN_CASES)("maps the $effect effect to the campaign type $expected", ({ effect, expected }) => {
    expect(lighterCampaignTradeType(effect)).toBe(expected);
  });

  it("maps an unestablished effect to unknown, never to either bucket", () => {
    expect(lighterCampaignTradeType(null)).toBe("unknown");
  });
});

describe("projectMarketDetail", () => {
  const PERP: LighterMarketDetail = {
    symbol: "ETH",
    market_id: 0,
    market_type: "perp",
    base_asset_id: 1,
    quote_asset_id: 0,
    status: "active",
    taker_fee: "0.0350",
    maker_fee: "0.0000",
    liquidation_fee: "0.0100",
    min_base_amount: "0.001",
    min_quote_amount: "10",
    supported_size_decimals: 4,
    supported_price_decimals: 2,
    supported_quote_decimals: 6,
    order_quote_limit: "1000000",
    is_maker_fee_enabled: true,
    is_taker_fee_enabled: true,
    // K2's live RHC market 0 reading.
    default_initial_margin_fraction: 5000,
    min_initial_margin_fraction: 200,
    maintenance_margin_fraction: 120,
    closeout_margin_fraction: 80,
    mark_price: "3024.66",
    index_price: "3024.10",
  };

  it("emits the margin fractions with the scale that makes them readable", () => {
    const projected = projectMarketDetail(PERP);
    expect(projected.margin).toEqual({
      scale: 10_000,
      scaleNote: "Provider fractions on a 10000 scale: 5000 is 50 percent.",
      defaultInitialFraction: 5000,
      minInitialFraction: 200,
      maintenanceFraction: 120,
      closeoutFraction: 80,
    });
  });

  it("keeps the mark and index prices as the provider's decimal strings", () => {
    const projected = projectMarketDetail(PERP);
    expect(projected.markPrice).toBe("3024.66");
    expect(projected.indexPrice).toBe("3024.10");
  });

  it("reports nulls, not zeros, on a spot market that carries none of them", () => {
    const spot: LighterMarketDetail = {
      ...PERP,
      market_type: "spot",
      market_id: 2048,
      default_initial_margin_fraction: undefined,
      min_initial_margin_fraction: undefined,
      maintenance_margin_fraction: undefined,
      closeout_margin_fraction: undefined,
      mark_price: undefined,
      index_price: undefined,
    };
    const projected = projectMarketDetail(spot);
    const margin = projected.margin as Record<string, unknown>;
    // A zero margin requirement is a claim; absence is the truth here.
    expect(margin.defaultInitialFraction).toBeNull();
    expect(margin.maintenanceFraction).toBeNull();
    expect(projected.markPrice).toBeNull();
    expect(projected.indexPrice).toBeNull();
  });
});
