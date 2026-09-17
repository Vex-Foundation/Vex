import { describe, expect, it } from "vitest";
import type { LighterTradingFill } from "@shared/schemas/lighter-trading.js";
import { fillSentence, fillSince } from "../desk-fill-outcome.js";

function fill(over: Partial<LighterTradingFill>): LighterTradingFill {
  return {
    tradeId: "t1", marketId: 1, symbol: "BTC", side: "buy", role: "taker", type: "trade",
    size: "0.0002", price: "77199.7", value: "15.43994", realizedPnl: null, timestamp: 1_700_000_100_000,
    ...over,
  };
}

const SENT_AT = 1_700_000_090_000;

describe("fillSince", () => {
  it("takes the newest fill on the market since the send and skips older ones and other markets", () => {
    const fills = [
      fill({ tradeId: "other", marketId: 2, timestamp: SENT_AT + 1_000 }),
      fill({ tradeId: "mine", timestamp: SENT_AT + 1_000 }),
      fill({ tradeId: "old", timestamp: SENT_AT - 60_000 }),
    ];
    expect(fillSince(fills, { marketId: 1, sentAt: SENT_AT, suffix: "" })?.tradeId).toBe("mine");
    expect(fillSince([fills[2]!], { marketId: 1, sentAt: SENT_AT, suffix: "" })).toBeNull();
  });

  it("reads second-stamped fills and allows a few seconds of clock skew", () => {
    const seconds = fill({ timestamp: Math.floor((SENT_AT - 3_000) / 1_000) });
    expect(fillSince([seconds], { marketId: 1, sentAt: SENT_AT, suffix: "" })).toBe(seconds);
  });
});

describe("fillSentence", () => {
  it("says what filled, grouped like the account panel", () => {
    expect(fillSentence(fill({ size: "1.5", price: "2900.25", symbol: "ETH" }))).toBe("Filled 1.5 ETH at 2,900.25.");
  });
});
