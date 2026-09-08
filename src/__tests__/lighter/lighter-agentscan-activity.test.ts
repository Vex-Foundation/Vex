/**
 * THE LIGHTER ROW BUILDERS - what AgentScan is told about a fill, and the four
 * ways getting it wrong would misreport money.
 *
 * Each block below is a defect the shape exists to prevent, not a line to
 * cover:
 *
 *   1. THE FEE SIDE. The integrator tick and the exchange tier fee both differ
 *      between maker and taker, and the account's own side of a trade is not
 *      the trade's `is_maker_ask` - it depends on which side the account was
 *      on. Reading it backwards reports the wrong fee on every fill.
 *   2. THE FEE BASIS. A spot BUY is charged on the received base; everything
 *      else on the quote notional. One basis applied to the other is a fee
 *      estimate off by the price of the asset.
 *   3. FLOATING POINT. A price times a size through a double has already lost
 *      the digits that make it a money figure.
 *   4. AUTHORIZED VERSUS CHARGED. A tick is what the approval permits; only
 *      the provider's own report is what was taken. A charged amount that
 *      defaults to zero reads as "no fee was charged", which is a different
 *      claim from "we do not know yet".
 */

import { describe, it, expect } from "vitest";

import type { LighterTrade } from "@tools/lighter/types.js";
import {
  buildLighterFillRecord,
  buildLighterWithdrawalActivityRow,
  estimateFeeUsd,
  estimateIntegratorFeeRaw,
  isLighterFillBuildFailure,
  lighterFillIdentity,
  lighterVenueAssetId,
  multiplyDecimals,
  type LighterFillFeeTerms,
  type LighterFillIntentFacts,
  type LighterMarketAssets,
} from "@vex-agent/tools/protocols/lighter/agentscan-activity.js";

const USDC = { venueAssetId: "lighter:core:asset:0", symbol: "USDC", decimals: 6 };
const ETH = { venueAssetId: "lighter:core:asset:1", symbol: "ETH", decimals: 18 };

const PERP_MARKET: LighterMarketAssets = {
  marketSymbol: "ETH-USD",
  baseAsset: ETH,
  quoteAsset: USDC,
};

const SPOT_MARKET: LighterMarketAssets = {
  marketSymbol: "ETH/USDC",
  baseAsset: ETH,
  quoteAsset: USDC,
};

const FEE_TERMS: LighterFillFeeTerms = {
  integratorMakerFeeTick: 1000,
  integratorTakerFeeTick: 1000,
  collectorAccountIndex: 743799,
  feeAuthorizationIntentId: "fee-intent-1",
  feeAsset: USDC,
};

function trade(overrides: Partial<LighterTrade> = {}): LighterTrade {
  return {
    trade_id: 99,
    trade_id_str: "99",
    tx_hash: "0xabc",
    type: "trade" as LighterTrade["type"],
    market_id: 1,
    size: "0.4",
    price: "2500.5",
    usd_amount: "1000.2",
    ask_id: 7,
    ask_id_str: "7",
    bid_id: 8,
    bid_id_str: "8",
    ask_account_id: 111,
    bid_account_id: 743799,
    is_maker_ask: true,
    block_height: 12345,
    timestamp: 1757000000,
    maker_fee: 2,
    taker_fee: 5,
    ...overrides,
  };
}

function intent(overrides: Partial<LighterFillIntentFacts> = {}): LighterFillIntentFacts {
  return {
    intentId: "intent-1",
    environment: "core",
    accountIndex: 743799,
    marketIndex: 1,
    side: "buy",
    clientOrderIndex: "555",
    ...overrides,
  };
}

function buildOrThrow(input: Parameters<typeof buildLighterFillRecord>[0]) {
  const result = buildLighterFillRecord(input);
  if (isLighterFillBuildFailure(result)) {
    throw new Error(`expected a fill record, got ${result.reason}`);
  }
  return result;
}

describe("Lighter fill identity", () => {
  it("is the canonical encoding, in one spelling", () => {
    expect(
      lighterFillIdentity({ environment: "rhc", accountIndex: 22869, marketIndex: 3, providerTradeId: "42" }),
    ).toBe("lighter:rhc:22869:3:42");
  });

  it("separates the two environments for the same account and trade id", () => {
    const core = lighterFillIdentity({ environment: "core", accountIndex: 1, marketIndex: 1, providerTradeId: "1" });
    const rhc = lighterFillIdentity({ environment: "rhc", accountIndex: 1, marketIndex: 1, providerTradeId: "1" });
    expect(core).not.toBe(rhc);
  });

  it("namespaces venue assets, inventing no EVM address", () => {
    expect(lighterVenueAssetId("core", 0)).toBe("lighter:core:asset:0");
    expect(lighterVenueAssetId("rhc", "7")).toBe("lighter:rhc:asset:7");
  });
});

describe("exact decimal arithmetic", () => {
  it.each([
    ["0.4", "2500.5", "1000.2"],
    ["1", "1", "1"],
    ["0.1", "0.2", "0.02"],
    ["3", "0.000001", "0.000003"],
  ])("multiplies %s by %s exactly", (a, b, expected) => {
    expect(multiplyDecimals(a, b)).toBe(expected);
  });

  it("keeps digits a double would lose", () => {
    // 0.1 * 0.2 is 0.020000000000000004 in IEEE-754 doubles.
    expect(multiplyDecimals("0.1", "0.2")).toBe("0.02");
    expect(Number("0.1") * Number("0.2")).not.toBe(0.02);
  });

  it("refuses a non-decimal operand rather than coercing it", () => {
    expect(multiplyDecimals("1e3", "2")).toBeNull();
    expect(multiplyDecimals("-1", "2")).toBeNull();
  });

  it("floors the integrator fee so an estimate never exceeds what could have been charged", () => {
    // 1000.2 quote at 10 bps (1000 ticks of a millionth) = 1.0002 USDC = 1000200 units.
    expect(estimateIntegratorFeeRaw("1000.2", 1000, 6)).toBe("1000200");
    // A basis that does not divide evenly floors rather than rounds up.
    expect(estimateIntegratorFeeRaw("0.0000009", 1000, 6)).toBe("0");
  });

  it("refuses a tick outside the provider's own range", () => {
    expect(estimateIntegratorFeeRaw("100", 1_000_001, 6)).toBeNull();
    expect(estimateIntegratorFeeRaw("100", -1, 6)).toBeNull();
  });
});

describe("buildLighterFillRecord", () => {
  it("derives the account's own maker side, not the trade's ask side", () => {
    // The account bought and the ASK was the maker, so the account is the TAKER.
    const taker = buildOrThrow({
      trade: trade({ is_maker_ask: true }),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(taker.feeSide).toBe("taker");
    expect(taker.exchangeFeeTickObserved).toBe(5);

    // Same trade, the account on the ask side: now it is the MAKER.
    const maker = buildOrThrow({
      trade: trade({ is_maker_ask: true }),
      intent: intent({ side: "sell" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(maker.feeSide).toBe("maker");
    expect(maker.exchangeFeeTickObserved).toBe(2);
  });

  it("reads the maker and taker integrator ticks apart", () => {
    const terms: LighterFillFeeTerms = { ...FEE_TERMS, integratorMakerFeeTick: 400, integratorTakerFeeTick: 1000 };
    const asMaker = buildOrThrow({
      trade: trade({ is_maker_ask: true }),
      intent: intent({ side: "sell" }),
      market: PERP_MARKET,
      feeTerms: terms,
    });
    const asTaker = buildOrThrow({
      trade: trade({ is_maker_ask: true }),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: terms,
    });
    expect(asMaker.integratorFeeTickAuthorized).toBe(400);
    expect(asTaker.integratorFeeTickAuthorized).toBe(1000);
  });

  it("keeps the AUTHORIZED tick apart from the one the provider OBSERVED", () => {
    // The authorization permits 1000 on the taker side; the provider stamped
    // 350 on this trade. Both are facts and they answer different questions,
    // so neither may stand in for the other (H0 correction 6).
    const record = buildOrThrow({
      trade: trade({ is_maker_ask: true, integrator_taker_fee: 350, taker_fee: 100 }),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: { ...FEE_TERMS, integratorTakerFeeTick: 1000 },
    });
    expect(record.integratorFeeTickAuthorized).toBe(1000);
    expect(record.integratorFeeTickObserved).toBe(350);
    expect(record.exchangeFeeTickObserved).toBe(100);
    // The estimate follows what the provider DID: 1000.2 * 350 / 1e6 in 6dp.
    expect(record.integratorFeeEstimateTickSource).toBe("observed");
    expect(record.integratorFeeEstimatedRaw).toBe("350070");
  });

  it("reads the OBSERVED integrator tick from the side the account was on", () => {
    const asMaker = buildOrThrow({
      trade: trade({ is_maker_ask: true, integrator_maker_fee: 28, integrator_taker_fee: 350 }),
      intent: intent({ side: "sell" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(asMaker.integratorFeeTickObserved).toBe(28);
  });

  it("falls back to the AUTHORIZED tick, labelled as such, when the record carries none", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.integratorFeeTickObserved).toBeNull();
    expect(record.integratorFeeEstimateTickSource).toBe("authorized");
  });

  it("refuses an observed tick outside the provider's own rate range", () => {
    // A "tick" above 1e6 is not a rate. Reading it as one would compute a fee
    // larger than the trade, so it reads as "no tick reported" instead.
    const record = buildOrThrow({
      trade: trade({ is_maker_ask: true, integrator_taker_fee: 1_000_001, taker_fee: -4 }),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.integratorFeeTickObserved).toBeNull();
    expect(record.exchangeFeeTickObserved).toBeNull();
    expect(record.integratorFeeEstimateTickSource).toBe("authorized");
  });

  it("charges a perpetual on the quote notional", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.quoteNotional).toBe("1000.2");
    expect(record.integratorFeeEstimateBasis).toBe("quote_notional");
    expect(record.integratorFeeEstimatedRaw).toBe("1000200");
  });

  it("charges a SPOT BUY on the received base, not the quote notional", () => {
    const record = buildOrThrow({
      trade: trade({ market_id: 2049 }),
      intent: intent({ side: "buy", marketIndex: 2049 }),
      market: SPOT_MARKET,
      feeTerms: { ...FEE_TERMS, feeAsset: ETH },
    });
    expect(record.integratorFeeEstimateBasis).toBe("received_base");
    // 0.4 ETH at 10 bps = 0.0004 ETH, in 18 decimals.
    expect(record.integratorFeeEstimatedRaw).toBe("400000000000000");
  });

  it("charges a SPOT SELL on the quote notional", () => {
    const record = buildOrThrow({
      trade: trade({ market_id: 2049 }),
      intent: intent({ side: "sell", marketIndex: 2049 }),
      market: SPOT_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.integratorFeeEstimateBasis).toBe("quote_notional");
  });

  it("never reports a charged fee it has not been told", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    // NULL, and specifically not zero: a zero is a proven amount and would
    // read as "no fee was taken".
    expect(record.integratorFeeChargedRaw).toBeNull();
    expect(record.exchangeFeeChargedRaw).toBeNull();
    expect(record.integratorFeeChargedRaw).not.toBe("0");
  });

  it("carries the fee authorization as provenance only", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.feeAuthorizationIntentId).toBe("fee-intent-1");
    expect(record.collectorAccountIndex).toBe(743799);
    // The authorization does not make the charge proven.
    expect(record.integratorFeeChargedRaw).toBeNull();
  });

  it("records a partial fill on its own facts, never the order's", () => {
    // Two fills of one order: distinct trade ids, distinct sizes, one intent.
    const first = buildOrThrow({
      trade: trade({ trade_id_str: "101", size: "0.1", block_height: 500 }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    const second = buildOrThrow({
      trade: trade({ trade_id_str: "102", size: "0.3", block_height: 501 }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(first.canonicalIdentity).not.toBe(second.canonicalIdentity);
    expect(first.executionIntentId).toBe(second.executionIntentId);
    expect(first.baseSize).toBe("0.1");
    expect(second.baseSize).toBe("0.3");
    expect(first.quoteNotional).toBe("250.05");
  });

  it("takes the provider order id from the account's own side", () => {
    const bought = buildOrThrow({
      trade: trade(),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    const sold = buildOrThrow({
      trade: trade(),
      intent: intent({ side: "sell" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(bought.providerOrderId).toBe("8");
    expect(sold.providerOrderId).toBe("7");
  });

  it("builds for both environments", () => {
    const rhc = buildOrThrow({
      trade: trade(),
      intent: intent({ environment: "rhc", accountIndex: 22869 }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(rhc.environment).toBe("rhc");
    expect(rhc.canonicalIdentity).toBe("lighter:rhc:22869:1:99");
  });

  it("refuses a trade record it cannot read rather than reporting a half fill", () => {
    expect(buildLighterFillRecord({
      trade: trade({ trade_id_str: "" }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    })).toEqual({ kind: "unbuildable", reason: "missing_trade_identity" });

    expect(buildLighterFillRecord({
      trade: trade({ price: "not-a-price" }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    })).toEqual({ kind: "unbuildable", reason: "malformed_amount" });
  });

  it("leaves the estimate absent when the authorization has no tick for this side", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: { ...FEE_TERMS, integratorTakerFeeTick: null },
    });
    expect(record.integratorFeeTickAuthorized).toBeNull();
    expect(record.integratorFeeTickObserved).toBeNull();
    expect(record.integratorFeeEstimateTickSource).toBeNull();
    expect(record.integratorFeeEstimatedRaw).toBeNull();
    expect(record.integratorFeeEstimateBasis).toBeNull();
    expect(record.integratorFeeAsset).toBeNull();
  });
});

describe("the exchange funding row a claimed withdrawal reports", () => {
  it("identifies the withdrawal by its SETTLEMENT chain, not the Lighter L2", () => {
    const row = buildLighterWithdrawalActivityRow({
      settlementChainId: 466324,
      txHash: "0xfeed",
      asset: { address: "0xUSDG", symbol: "USDG", decimals: 6 },
      amountRaw: "5000000",
      environment: "rhc",
      accountIndex: 22869,
    });
    expect(row).toMatchObject({
      kind: "exchange",
      eventRole: "exchange_withdrawal",
      protocol: "lighter",
      chainFamily: "eip155",
      chainId: 466324,
      txHash: "0xfeed",
      amountRaw: "5000000",
    });
    // 304 and 466324 are Lighter L2 signer chain ids on Core and RHC; the row
    // names the SETTLEMENT chain of the RHC deployment, where the receipt is.
    expect(row.chainId).not.toBe(304);
  });
});

describe("what is never reported", () => {
  it("has no builder for a cancel, a modify or a close", async () => {
    const module = await import("@vex-agent/tools/protocols/lighter/agentscan-activity.js");
    const exported = Object.keys(module).join(" ").toLowerCase();
    expect(exported).not.toMatch(/cancel|modif|close|liquidat/);
  });
});

/**
 * LIGHTER'S OWN TRADE FACTS ON THE FILL ROW.
 *
 * Everything below is a field the campaign API reads and none of it is Vex
 * arithmetic: the trade type, the venue's own match time, Lighter's USD
 * notional, the account's position before the fill and the realized PnL
 * Lighter attributes to it. The one derivation is the position EFFECT, which
 * names the transition those fields already describe.
 */
describe("the trade facts a fill carries", () => {
  it("keeps Lighter's own USD amount beside our computed quote notional", () => {
    const record = buildOrThrow({
      trade: trade({ usd_amount: "1000.20" }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    // Two different numbers with two different authorities: `usdAmount` is the
    // provider's word and is what the campaign sums; `quoteNotional` is our
    // exact size x price in the QUOTE asset.
    expect(record.usdAmount).toBe("1000.20");
    expect(record.quoteNotional).toBe("1000.2");
  });

  it("reads the trade timestamp as milliseconds, the unit measured live", () => {
    const record = buildOrThrow({
      trade: trade({ timestamp: 1788858716527, transaction_time: 1788858716531726 }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.tradedAt).toBe("2026-09-08T09:11:56.527Z");
    expect(record.transactionTimeUs).toBe("1788858716531726");
  });

  it("carries the provider's own classification of the record", () => {
    const record = buildOrThrow({
      trade: trade({ type: "liquidation" }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    // A liquidation is a fill the user did not ask for, and reporting it as
    // ordinary trading would misdescribe what happened to the account.
    expect(record.tradeType).toBe("liquidation");
  });

  it("refuses a record whose USD amount it cannot read", () => {
    expect(buildLighterFillRecord({
      trade: trade({ usd_amount: "n/a" }),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    })).toEqual({ kind: "unbuildable", reason: "malformed_amount" });
  });

  it("holds the account's own half null when the observation was a public row", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: intent(),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    // The public tape carries no realized PnL, so nothing about the account's
    // position is established - and NULL is not the same claim as "unknown".
    expect(record.accountFacts).toBeNull();
    expect(record.positionEffect).toBeNull();
  });

  it("establishes the effect from the account's own half of an authenticated row", () => {
    const record = buildOrThrow({
      // The account (743799) is the BIDDER, and `is_maker_ask: true` makes the
      // bidder the taker, so its own fields are the TAKER ones.
      trade: trade({
        is_maker_ask: true,
        taker_position_size_before: "-2.5",
        taker_entry_quote_before: "-6000.000000",
        taker_position_sign_changed: false,
        bid_account_pnl: "1.989696",
        ask_account_pnl: "-9.999999",
      }),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.accountFacts).toEqual({
      positionSizeBefore: "-2.5",
      positionSignChanged: false,
      entryQuoteBefore: "-6000.000000",
      // The BID pnl, because the account bought. The ask value beside it is
      // the counterparty's and must never be reported as the user's.
      accountPnl: "1.989696",
      initialMarginFractionBefore: null,
    });
    // Short 2.5, bought 0.4: a reduce.
    expect(record.positionEffect).toBe("reduce");
  });

  it("estimates the fees in USD on Lighter's own amount, never on an assumed parity", () => {
    const record = buildOrThrow({
      trade: trade({ usd_amount: "1000.20", integrator_taker_fee: 1000, taker_fee: 350 }),
      intent: intent({ side: "buy" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    // 1000.20 x 1000 / 1e6 and 1000.20 x 350 / 1e6, floored at six places.
    expect(record.integratorFeeEstimatedUsd).toBe("1.000200");
    expect(record.exchangeFeeEstimatedUsd).toBe("0.350070");
  });

  it("withholds a USD integrator estimate on a spot buy, which is charged in base", () => {
    const record = buildOrThrow({
      trade: trade({ usd_amount: "1000.20", integrator_taker_fee: 1000, taker_fee: 350 }),
      intent: intent({ side: "buy", marketIndex: 4096 }),
      market: SPOT_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.integratorFeeEstimateBasis).toBe("received_base");
    // Converting a base-denominated fee to USD would need a rate nobody here
    // measured, so no number is produced at all.
    expect(record.integratorFeeEstimatedUsd).toBeNull();
    // The exchange fee is charged on the notional and keeps its USD estimate.
    expect(record.exchangeFeeEstimatedUsd).toBe("0.350070");
  });
});

/**
 * FILLS OBSERVED BEFORE THEIR INTENT: held, never reported, attached only on
 * the venue's own evidence.
 */
describe("a fill with no intent", () => {
  const SCOPE = { environment: "core" as const, accountIndex: 743799, marketIndex: 1 };

  it("is buildable from the observation scope, with no execution intent", () => {
    const record = buildOrThrow({
      trade: trade(),
      intent: null,
      observation: SCOPE,
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(record.executionIntentId).toBeNull();
    expect(record.clientOrderId).toBeNull();
    expect(record.canonicalIdentity).toBe("lighter:core:743799:1:99");
  });

  it("takes its side from the trade record, which names both parties", () => {
    // The account 743799 is the bidder on this record, so it bought.
    const bought = buildOrThrow({
      trade: trade(),
      intent: null,
      observation: SCOPE,
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(bought.side).toBe("buy");
    expect(bought.providerOrderId).toBe("8");

    const sold = buildOrThrow({
      trade: trade({ ask_account_id: 743799, bid_account_id: 111 }),
      intent: null,
      observation: SCOPE,
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(sold.side).toBe("sell");
    expect(sold.providerOrderId).toBe("7");
  });

  it("refuses to build without a scope, rather than inventing an account", () => {
    expect(buildLighterFillRecord({
      trade: trade(),
      intent: null,
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    })).toEqual({ kind: "unbuildable", reason: "missing_observation_scope" });
  });

  it("refuses a record the scope's account is not party to", () => {
    expect(buildLighterFillRecord({
      trade: trade(),
      intent: null,
      observation: { ...SCOPE, accountIndex: 999_999 },
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    })).toEqual({ kind: "unbuildable", reason: "account_not_party_to_trade" });
  });

  it("refuses a record where the account is its own counterparty", () => {
    expect(buildLighterFillRecord({
      trade: trade({ ask_account_id: 743799 }),
      intent: null,
      observation: SCOPE,
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    })).toEqual({ kind: "unbuildable", reason: "account_not_party_to_trade" });
  });
});

describe("the USD fee estimate", () => {
  it.each([
    ["1000.20", 1000, "1.000200"],
    ["1000.20", 350, "0.350070"],
    ["0.74", 350, "0.000259"],
    ["1567.082000", 28, "0.043878"],
    ["0", 1000, "0.000000"],
  ])("estimates %s at %s ticks as %s USD", (usdAmount, tick, expected) => {
    expect(estimateFeeUsd(usdAmount, tick)).toBe(expected);
  });

  it("floors rather than rounding up, so an estimate never exceeds the charge", () => {
    // 0.74 x 350 / 1e6 = 0.000259, exactly; 0.75 x 350 / 1e6 = 0.0002625, and
    // the sub-microdollar remainder is dropped rather than rounded up.
    expect(estimateFeeUsd("0.75", 350)).toBe("0.000262");
  });

  it("produces nothing from a tick that is not a rate", () => {
    expect(estimateFeeUsd("1000.20", null)).toBeNull();
    expect(estimateFeeUsd("1000.20", 1_000_001)).toBeNull();
    expect(estimateFeeUsd("1000.20", -1)).toBeNull();
    expect(estimateFeeUsd("n/a", 1000)).toBeNull();
  });
});
