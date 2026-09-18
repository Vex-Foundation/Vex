import { describe, expect, it } from "vitest";
import type { LighterTradingFill } from "@shared/schemas/lighter-trading.js";
import {
  executionTradeId,
  fillByTradeId,
  fillSentence,
  fillsForOrder,
  parseDeskOrderExecution,
  totalFillSize,
} from "../desk-fill-outcome.js";

function fill(over: Partial<LighterTradingFill>): LighterTradingFill {
  return {
    tradeId: "t1", orderId: "9", marketId: 1, symbol: "BTC", side: "buy", role: "taker", type: "trade",
    size: "0.0002", price: "77199.7", value: "15.43994", realizedPnl: null, timestamp: 1_700_000_100_000,
    ...over,
  };
}

const SENT_AT = 1_700_000_090_000;

describe("fillByTradeId", () => {
  it("uses only the exact trade proven by the execution result", () => {
    const fills = [
      fill({ tradeId: "other", marketId: 2, timestamp: SENT_AT + 1_000 }),
      fill({ tradeId: "mine", timestamp: SENT_AT + 1_000 }),
      fill({ tradeId: "old", timestamp: SENT_AT - 60_000 }),
    ];
    expect(fillByTradeId(fills, { marketId: 1, tradeId: "mine", suffix: "" })?.tradeId).toBe("mine");
    const oldFill = fills[2];
    if (!oldFill) throw new Error("expected old fill");
    expect(fillByTradeId([oldFill], { marketId: 1, tradeId: "mine", suffix: "" })).toBeNull();
  });
});

describe("executionTradeId", () => {
  it("accepts account-trade evidence only in the approved scope", () => {
    const output = JSON.stringify({
      status: "provider_confirmed",
      environment: "rhc",
      executionState: "partially_filled",
      evidenceSource: "account_trade",
      providerOrderId: "9",
      providerEvidence: { source: "account_trade", marketIndex: 1, tradeId: "mine", orderId: "9" },
    });
    expect(executionTradeId(output, "rhc", 1)).toBe("mine");
    expect(executionTradeId(output, "core", 1)).toBeNull();
    expect(executionTradeId(output, "rhc", 2)).toBeNull();
  });

  it("does not invent a fill identity from order-only evidence or text", () => {
    expect(executionTradeId(JSON.stringify({
      status: "provider_confirmed",
      environment: "rhc",
      executionState: "filled",
      evidenceSource: "inactive_order",
      providerOrderId: "9",
      providerEvidence: { source: "inactive_order", marketIndex: 1, orderId: "9" },
    }), "rhc", 1)).toBeNull();
    expect(executionTradeId("Order submitted.", "rhc", 1)).toBeNull();
  });
});

describe("parseDeskOrderExecution", () => {
  it("keeps exact terminal order amounts and average execution price", () => {
    const output = JSON.stringify({
      status: "provider_confirmed",
      environment: "rhc",
      executionState: "filled",
      evidenceSource: "inactive_order",
      providerOrderId: "9",
      providerEvidence: {
        source: "inactive_order",
        marketIndex: 1,
        orderId: "9",
        filledBaseAmount: "0.75",
        averageExecutionPrice: "3200.25",
      },
    });
    expect(parseDeskOrderExecution(output, "rhc", 1)).toMatchObject({
      state: "filled",
      source: "inactive_order",
      orderId: "9",
      filledBaseAmount: "0.75",
      averageExecutionPrice: "3200.25",
    });
  });

  it("rejects a mismatched market or conflicting provider order identity", () => {
    const output = (orderId: string, marketIndex = 1) => JSON.stringify({
      status: "provider_confirmed",
      environment: "rhc",
      executionState: "open",
      evidenceSource: "active_order",
      providerOrderId: "9",
      providerEvidence: { source: "active_order", marketIndex, orderId },
    });
    expect(parseDeskOrderExecution(output("9", 2), "rhc", 1)).toBeNull();
    expect(parseDeskOrderExecution(output("10"), "rhc", 1)).toBeNull();
  });
});

describe("fillsForOrder", () => {
  it("groups simultaneous fills by exact order id and sums decimal sizes exactly", () => {
    const fills = [
      fill({ tradeId: "a", orderId: "mine", size: "0.1" }),
      fill({ tradeId: "b", orderId: "other", size: "8" }),
      fill({ tradeId: "c", orderId: "mine", size: "0.02" }),
    ];
    const mine = fillsForOrder(fills, 1, "mine");
    expect(mine.map((row) => row.tradeId)).toEqual(["a", "c"]);
    expect(totalFillSize(mine)).toBe("0.12");
  });
});

describe("fillSentence", () => {
  it("says what filled, grouped like the account panel", () => {
    expect(fillSentence(fill({ size: "1.5", price: "2900.25", symbol: "ETH" }))).toBe("Filled 1.5 ETH at 2,900.25.");
  });
});
