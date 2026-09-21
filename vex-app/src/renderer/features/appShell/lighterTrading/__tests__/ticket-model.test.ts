import { describe, expect, it } from "vitest";
import type { LighterTradingAccount, LighterTradingMarket } from "../../../../../shared/schemas/lighter-trading.js";
import { bookInside, groupTickLabel, groupedLevels } from "../book-model.js";
import { addUnsignedDecimals, subtractUnsignedDecimals, toDecimal, trimDecimal } from "../decimal.js";
import {
  estimatedLiquidationPrice,
  leverageLabel,
  marginCost,
  maxBaseSize,
  protectionPrefill,
  resolveTicketMargin,
  slippageBound,
  toDeskOrderDraft,
  type TicketMargin,
} from "../ticket-model.js";

const MARKET: LighterTradingMarket = {
  marketId: 7,
  symbol: "ETH",
  marketType: "perp",
  status: "active",
  baseAssetId: 1,
  quoteAssetId: 3,
  minBaseAmount: "0.001",
  minQuoteAmount: "10",
  orderQuoteLimit: "100000",
  decimals: { size: 4, price: 2, quote: 6 },
  fees: { maker: "0", taker: "0.0003", makerEnabled: false, takerEnabled: true, integratorMaker: "0.1", integratorTaker: "0.1" },
  activity24h: { tradesCount: 120, quoteVolume: 1_600_000 },
  margin: { defaultInitialMarginFraction: 1_000, minInitialMarginFraction: 200, maintenanceMarginFraction: 400 },
};

describe("decimal helpers", () => {
  it("adds and subtracts unsigned decimals exactly", () => {
    expect(addUnsignedDecimals("0.1", "0.2")).toBe("0.3");
    expect(subtractUnsignedDecimals("101", "100")).toBe("1");
    expect(subtractUnsignedDecimals("100", "101")).toBeNull();
  });

  it("formats numbers to provider decimals without trailing zeros", () => {
    expect(trimDecimal("7.7870")).toBe("7.787");
    expect(toDecimal(7.78695, 4)).toBe("7.787");
    expect(toDecimal(0, 4)).toBeNull();
    expect(toDecimal(Number.NaN, 4)).toBeNull();
  });
});

describe("book model", () => {
  const rows = [
    { orderId: "a1", price: "101.23", size: "1" },
    { orderId: "a2", price: "101.27", size: "2" },
    { orderId: "a3", price: "101.31", size: "3" },
  ];

  it("groups asks up and bids down onto the coarser tick", () => {
    expect(groupedLevels(rows, "ask", 2, 10).map((level) => [level.price, level.size, level.total])).toEqual([
      ["101.30", "3", "3"],
      ["101.40", "3", "6"],
    ]);
    expect(groupedLevels(rows, "bid", 2, 10).map((level) => [level.price, level.size, level.total])).toEqual([
      ["101.30", "3", "3"],
      ["101.20", "3", "6"],
    ]);
    expect(groupTickLabel(10, 2)).toBe("0.10");
    expect(groupTickLabel(1, 2)).toBe("0.01");
  });

  it("derives the inside market in basis points", () => {
    const inside = bookInside({ asks: rows, bids: [{ orderId: "b1", price: "101.13", size: "1" }] });
    expect(inside.bestAsk).toBe("101.23");
    expect(inside.bestBid).toBe("101.13");
    expect(inside.spread).toBe("0.1");
    expect(inside.mid).toBeCloseTo(101.18);
    expect(inside.spreadBps).toBeCloseTo(9.88, 2);
    expect(bookInside({ asks: [], bids: [] }).spreadBps).toBeNull();
  });
});

describe("ticket margin math", () => {
  const margin: TicketMargin = { initialMarginFraction: 1_000, maintenanceMarginFraction: 400, marginMode: "cross", source: "market" };

  it("prefers the account's own terms for the market over the market default", () => {
    const term = { marketId: MARKET.marketId, initialMarginFraction: 500, marginMode: "isolated" as const };
    expect(resolveTicketMargin(MARKET, null)).toEqual(margin);
    expect(resolveTicketMargin(MARKET, [term])).toEqual({
      initialMarginFraction: 500,
      maintenanceMarginFraction: 400,
      marginMode: "isolated",
      source: "account",
    });
    // A term whose mode Lighter did not state reads as cross, like main's `currentTerms`.
    expect(resolveTicketMargin(MARKET, [{ ...term, marginMode: null }])?.marginMode).toBe("cross");
    expect(resolveTicketMargin(MARKET, [{ ...term, marketId: 99 }])).toEqual(margin);
    expect(resolveTicketMargin({ ...MARKET, margin: null }, null)).toBeNull();
    expect(resolveTicketMargin({ ...MARKET, marketType: "spot" }, [term])).toBeNull();
  });

  it("prices leverage, cost and maximum size on the 10000 scale", () => {
    expect(leverageLabel(1_000)).toBe("10x");
    expect(leverageLabel(1_500)).toBe("7x");
    expect(leverageLabel(295)).toBe("34x");
    expect(leverageLabel(3_334)).toBe("3x");
    expect(marginCost(1_284.2, 1_000)).toBeCloseTo(128.42);
    expect(maxBaseSize(5_000, 1_000, 3_210.5)).toBeCloseTo(15.5739, 4);
    expect(maxBaseSize(5_000, 1_000, 0)).toBe(0);
  });

  it("estimates an isolated liquidation price from the margin buffer", () => {
    expect(estimatedLiquidationPrice(3_210.5, "buy", margin)).toBeCloseTo(3_017.87);
    expect(estimatedLiquidationPrice(3_210.5, "sell", margin)).toBeCloseTo(3_403.13);
    expect(estimatedLiquidationPrice(3_210.5, "buy", { ...margin, maintenanceMarginFraction: null })).toBeNull();
    expect(estimatedLiquidationPrice(3_210.5, "buy", { ...margin, maintenanceMarginFraction: 1_000 })).toBeNull();
  });

  it("bounds protection legs one percent past the trigger on the close side", () => {
    expect(slippageBound("3000", "1", "sell", 2)).toBe("2970");
    expect(slippageBound("3500", "1", "buy", 2)).toBe("3535");
  });
});

describe("desk lane wire form", () => {
  const entry = { mode: "market" as const, side: "buy" as const, baseAmount: "0.5", worstPrice: "3226.56", reduceOnly: false };

  it("strips protection from the entry and keeps every price the ticket set", () => {
    expect(toDeskOrderDraft({
      ...entry,
      protection: { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null },
    })).toEqual(entry);
    expect(toDeskOrderDraft({
      mode: "limit", side: "sell", baseAmount: "0.2", limitPrice: "3300", timeInForce: "post-only", orderExpiryOffsetMinutes: 240, reduceOnly: true,
    })).toEqual({
      mode: "limit", side: "sell", baseAmount: "0.2", limitPrice: "3300", timeInForce: "post-only", orderExpiryOffsetMinutes: 240, reduceOnly: true,
    });
  });

  it("pins protective modes to reduce-only on the wire", () => {
    expect(toDeskOrderDraft({ mode: "stop-loss", side: "sell", baseAmount: "0.1", triggerPrice: "2900", worstPrice: "2850", reduceOnly: true }))
      .toEqual({ mode: "stop-loss", side: "sell", baseAmount: "0.1", triggerPrice: "2900", worstPrice: "2850", reduceOnly: true });
    expect(toDeskOrderDraft({
      mode: "take-profit-limit", side: "sell", baseAmount: "0.1", triggerPrice: "3300", limitPrice: "3275", timeInForce: "good-till-time", orderExpiryOffsetMinutes: 240, reduceOnly: true,
    })).toMatchObject({ mode: "take-profit-limit", reduceOnly: true, limitPrice: "3275" });
    expect(toDeskOrderDraft({
      mode: "oco", side: "sell", baseAmount: "0.1", stopLossTriggerPrice: "2900", stopLossPrice: "2850", takeProfitTriggerPrice: "3300", takeProfitPrice: "3250",
    })).toEqual({
      mode: "oco", side: "sell", baseAmount: "0.1", stopLossTriggerPrice: "2900", stopLossPrice: "2850", takeProfitTriggerPrice: "3300", takeProfitPrice: "3250",
    });
  });
});

describe("protection follow-up prefill", () => {
  const entry = { mode: "market" as const, side: "buy" as const, baseAmount: "0.5", worstPrice: "3226.56", reduceOnly: false };

  it("is nothing when no leg is attached or the draft is already protective", () => {
    expect(protectionPrefill(entry, 1)).toBeNull();
    expect(protectionPrefill({ ...entry, protection: { stopLoss: null, takeProfit: null } }, 1)).toBeNull();
    expect(protectionPrefill(
      { mode: "stop-loss", side: "sell", baseAmount: "0.1", triggerPrice: "2900", worstPrice: "2850", reduceOnly: true },
      1,
    )).toBeNull();
  });

  it("loads both legs as a reduce-only OCO on the close side, same size", () => {
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: { triggerPrice: "3500", price: "3465" } };
    expect(protectionPrefill({ ...entry, protection }, 7)).toEqual({
      key: 7,
      mode: "oco",
      side: "sell",
      baseAmount: "0.5",
      reduceOnly: true,
      protection,
    });
  });

  it("uses the provider-confirmed filled amount instead of the requested entry size", () => {
    const protection = { stopLoss: { triggerPrice: "3000", price: "2970" }, takeProfit: null };
    expect(protectionPrefill({ ...entry, protection }, 8, "0.2")).toMatchObject({
      mode: "stop-loss",
      side: "sell",
      baseAmount: "0.2",
      reduceOnly: true,
    });
  });

  it("loads a single leg as its own protective mode", () => {
    expect(protectionPrefill(
      { ...entry, side: "sell", protection: { stopLoss: null, takeProfit: { triggerPrice: "3000", price: "2970" } } },
      3,
    )).toEqual({ key: 3, mode: "take-profit", side: "buy", baseAmount: "0.5", reduceOnly: true, triggerPrice: "3000", price: "2970" });
  });
});
