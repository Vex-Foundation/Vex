import { describe, expect, it } from "vitest";
import { lighterOrderFacts } from "../ApprovalCard/lighter-order-facts.js";

function labels(rows: readonly { label: string; value: string }[] | null): Record<string, string> {
  return Object.fromEntries((rows ?? []).map((row) => [row.label, row.value]));
}

describe("lighterOrderFacts", () => {
  it("reads a market IOC entry as an order, with the worst price and no signed expiry", () => {
    const rows = labels(lighterOrderFacts({
      toolId: "lighter.order.create", side: "buy", orderType: "market", timeInForce: "immediate-or-cancel",
      marketType: "perp", marketSymbol: "BTC", environment: "rhc", reduceOnly: false,
      baseAmountDisplay: "0.0002", priceDisplay: "77199.7", notionalDisplay: "15.43994",
      triggerPriceDisplay: null, orderExpiryIso: "2026-09-17T17:33:44.151Z", matchHash: "abc",
    }));
    expect(rows).toEqual({
      Action: "Buy 0.0002 BTC",
      Market: "BTC perp · Robinhood Chain",
      Order: "Market IOC",
      Price: "Worst 77199.7",
      Notional: "≈ 15.44",
    });
  });

  it("keeps the expiry for a GTC limit and marks reduce-only protective orders with their trigger", () => {
    const rows = labels(lighterOrderFacts({
      toolId: "lighter.order.create", side: "sell", orderType: "stop-loss", timeInForce: "good-till-time",
      marketSymbol: "ETH", environment: "core", reduceOnly: true, baseAmountDisplay: "1.5",
      priceDisplay: "2900", triggerPriceDisplay: "2950", orderExpiryIso: "2026-09-18T17:00:00.000Z",
    }));
    expect(rows.Order).toBe("Stop-loss GTC · Reduce-only");
    expect(rows.Trigger).toBe("2950");
    expect(rows.Price).toBe("2900");
    expect(rows.Expires).toBe("2026-09-18T17:00:00.000Z");
    expect(rows.Market).toBe("ETH · Lighter Core");
  });

  it("reads an OCO card by its legs", () => {
    const rows = labels(lighterOrderFacts({
      toolId: "lighter.order.create", groupingType: "one-cancels-the-other", side: "sell", marketSymbol: "BTC",
      marketType: "perp", environment: "rhc", baseAmountDisplay: "0.0002", reduceOnly: true,
      stopLossTriggerDisplay: "75000", stopLossBoundDisplay: "74500",
      takeProfitTriggerDisplay: "80000", takeProfitBoundDisplay: "79500", orderExpiryIso: "2026-09-18T17:00:00.000Z",
    }));
    expect(rows.Action).toBe("Sell 0.0002 BTC · OCO");
    expect(rows["Stop-loss"]).toBe("75000 trigger · 74500 bound");
    expect(rows["Take-profit"]).toBe("80000 trigger · 79500 bound");
    expect(rows.Order).toBe("Reduce-only · one cancels the other");
  });

  it("reads a close card as the position it flattens", () => {
    const rows = labels(lighterOrderFacts({
      toolId: "lighter.position.close", environment: "rhc", symbol: "BTC", positionSide: "long", positionAmount: "0.5",
      averageEntryPrice: "76000", closingSide: "sell", worstAcceptablePrice: "75240", maxSlippageBps: 100,
      reduceOnly: true, orderType: "market", timeInForce: "immediate-or-cancel",
    }));
    expect(rows).toEqual({
      Action: "Close 0.5 BTC long",
      Market: "BTC · Robinhood Chain",
      Order: "Sell Market IOC · Reduce-only",
      "Worst price": "75240",
      "Max slippage": "100 bps",
      Entry: "76000",
    });
  });

  it("reads a cancel card by the order it removes", () => {
    const rows = labels(lighterOrderFacts({
      toolId: "lighter.order.cancel", environment: "rhc", marketIndex: 1, providerOrderId: "12345", side: "buy",
      orderType: "limit", timeInForce: "good-till-time", price: "75000", remainingBaseAmount: "0.3", filledBaseAmount: "0.2",
    }));
    expect(rows).toEqual({
      Action: "Cancel order 12345",
      Market: "Market 1 · Robinhood Chain",
      Order: "Buy Limit GTC at 75000",
      Open: "0.3 remaining · 0.2 filled",
    });
  });

  it("reads a modify card as the before and after of the order", () => {
    const rows = labels(lighterOrderFacts({
      toolId: "lighter.order.modify", environment: "core", marketIndex: 0, providerOrderId: "777", side: "sell",
      orderType: "limit", timeInForce: "good-till-time", price: "80000", initialBaseAmount: "0.5",
      requestedBaseAmount: "0.4", requestedPrice: "81000", filledBaseAmount: "0.1",
    }));
    expect(rows).toEqual({
      Action: "Modify order 777",
      Market: "Market 0 · Lighter Core",
      Order: "Sell Limit GTC",
      From: "0.5 at 80000",
      To: "0.4 at 81000",
      Filled: "0.1 already filled",
    });
  });

  it("reads a cancel-all card by how many orders it covers", () => {
    expect(labels(lighterOrderFacts({
      toolId: "lighter.order.cancelAll", environment: "rhc", accountIndex: 22869, orderCount: 3,
    }))).toEqual({ Action: "Cancel all 3 active orders", Market: "Robinhood Chain", Account: "22869" });
    expect(labels(lighterOrderFacts({ toolId: "lighter.order.cancelAll", orderCount: 1 }))).toEqual({
      Action: "Cancel all 1 active order",
    });
  });

  it("skips absent facts and stays out of other cards", () => {
    expect(labels(lighterOrderFacts({ toolId: "lighter.order.cancel" }))).toEqual({ Action: "Cancel order" });
    expect(lighterOrderFacts({ toolId: "lighter.fees.approve" })).toBeNull();
    expect(lighterOrderFacts({ toolId: "lighter.account.transfer" })).toBeNull();
  });
});
