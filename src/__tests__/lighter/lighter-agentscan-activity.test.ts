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
  buildLighterDepositActivityRow,
  buildLighterFillRecord,
  buildLighterWithdrawalActivityRow,
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
    expect(taker.exchangeFeeTick).toBe(5);

    // Same trade, the account on the ask side: now it is the MAKER.
    const maker = buildOrThrow({
      trade: trade({ is_maker_ask: true }),
      intent: intent({ side: "sell" }),
      market: PERP_MARKET,
      feeTerms: FEE_TERMS,
    });
    expect(maker.feeSide).toBe("maker");
    expect(maker.exchangeFeeTick).toBe(2);
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
    expect(asMaker.integratorFeeTick).toBe(400);
    expect(asTaker.integratorFeeTick).toBe(1000);
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
    expect(record.integratorFeeTick).toBeNull();
    expect(record.integratorFeeEstimatedRaw).toBeNull();
    expect(record.integratorFeeEstimateBasis).toBeNull();
    expect(record.integratorFeeAsset).toBeNull();
  });
});

describe("exchange funding rows", () => {
  it("identifies a deposit by its SETTLEMENT chain, not the Lighter L2", () => {
    const row = buildLighterDepositActivityRow({
      settlementChainId: 1,
      txHash: "0xdeadbeef",
      asset: { address: "0xA0b8", symbol: "USDC", decimals: 6 },
      amountRaw: "1000000",
      environment: "core",
      accountIndex: 743799,
    });
    expect(row).toMatchObject({
      kind: "exchange",
      eventRole: "exchange_deposit",
      protocol: "lighter",
      chainFamily: "eip155",
      chainId: 1,
      txHash: "0xdeadbeef",
      amountRaw: "1000000",
    });
    // 304 and 466324 are Lighter L2 signer chain ids; a receipt reader asked
    // for either would find nothing.
    expect(row.chainId).not.toBe(304);
  });

  it("identifies a claimed withdrawal the same way", () => {
    const row = buildLighterWithdrawalActivityRow({
      settlementChainId: 466324,
      txHash: "0xfeed",
      asset: { address: "0xUSDG", symbol: "USDG", decimals: 6 },
      amountRaw: "5000000",
      environment: "rhc",
      accountIndex: 22869,
    });
    expect(row.eventRole).toBe("exchange_withdrawal");
    expect(row.chainFamily).toBe("eip155");
  });
});

describe("what is never reported", () => {
  it("has no builder for a cancel, a modify or a close", async () => {
    const module = await import("@vex-agent/tools/protocols/lighter/agentscan-activity.js");
    const exported = Object.keys(module).join(" ").toLowerCase();
    expect(exported).not.toMatch(/cancel|modif|close|liquidat/);
  });
});
