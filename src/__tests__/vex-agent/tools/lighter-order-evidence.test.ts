import { describe, expect, it } from "vitest";

import type { LighterAccountOrder } from "@tools/lighter/types.js";
import {
  buildLighterOrderEvidenceScope,
  findMatchingLighterOrder,
  lighterDecimalGreaterThanZero,
  lighterOrderEvidenceJson,
  lighterOrderMatchesEvidenceScope,
  stateFromInactiveLighterOrder,
} from "@vex-agent/tools/protocols/lighter/order-evidence.js";

function inactiveOrder(overrides: Partial<LighterAccountOrder> = {}): LighterAccountOrder {
  return {
    order_index: 987,
    client_order_index: 123456,
    order_id: "987",
    client_order_id: "123456",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0",
    remaining_base_amount: "1.0",
    filled_base_amount: "0",
    price: "2000.00",
    status: "canceled",
    ...overrides,
  };
}

describe("Lighter inactive order evidence", () => {
  it.each(["canceled", "canceled-expired", "expired"])(
    "classifies %s with a positive fill as partially filled",
    (status) => {
      expect(stateFromInactiveLighterOrder(inactiveOrder({
        status,
        filled_base_amount: "0.25",
        remaining_base_amount: "0.75",
      }))).toBe("partially_filled");
    },
  );

  it("keeps zero-fill cancellation and full-fill outcomes distinct", () => {
    expect(stateFromInactiveLighterOrder(inactiveOrder())).toBe("canceled");
    expect(stateFromInactiveLighterOrder(inactiveOrder({
      status: "filled",
      filled_base_amount: "1.0",
      remaining_base_amount: "0",
    }))).toBe("filled");
  });

  it("recognizes exact positive decimal evidence without floating-point conversion", () => {
    expect(lighterDecimalGreaterThanZero("0.00000000000000000000000000000000000001")).toBe(true);
    expect(lighterDecimalGreaterThanZero("0.00000000000000000000000000000000000000")).toBe(false);
    expect(lighterDecimalGreaterThanZero("1e-8")).toBe(false);
  });

  it("accepts normalized provider semantics and persists them as bounded evidence", () => {
    const order = inactiveOrder({
      side: "SELL",
      type: "STOP_LOSS_LIMIT",
      time_in_force: "GOOD_TILL_TIME",
      reduce_only: true,
      trigger_price: "2900.00",
      order_expiry: 1_800_000_000_000,
    });
    const scope = buildLighterOrderEvidenceScope({
      approved: {
        accountIndex: 42,
        marketIndex: 0,
        side: "sell",
        orderType: "stop-loss-limit",
        timeInForce: "good-till-time",
        reduceOnly: true,
        baseAmountInteger: "10000",
        priceInteger: "200000",
        triggerPriceInteger: "290000",
      },
      baseDecimals: 4,
      priceDecimals: 2,
      signedOrderExpiryMs: 1_800_000_000_000,
    });

    expect(lighterOrderMatchesEvidenceScope(order, scope)).toBe(true);
    expect(findMatchingLighterOrder([order], scope, "123456")).toBe(order);
    expect(lighterOrderEvidenceJson("inactive_order", order, "123456")).toMatchObject({
      side: "sell",
      orderType: "STOP_LOSS_LIMIT",
      timeInForce: "GOOD_TILL_TIME",
      reduceOnly: true,
      triggerPrice: "2900.00",
      initialBaseAmount: "1.0",
      price: "2000.00",
    });
  });

  it.each([
    { side: "buy" },
    { type: "take_profit_limit" },
    { time_in_force: "immediate_or_cancel" },
    { reduce_only: false },
    { trigger_price: "0" },
    { initial_base_amount: "1.0001" },
    { price: "2000.01" },
    { order_expiry: 1_800_000_000_001 },
    { base_price: Number.MAX_SAFE_INTEGER + 1 },
    { base_price: 200001 },
  ])("fails closed when provider semantics conflict with the approved order: %o", (override) => {
    const order = inactiveOrder({
      side: "sell",
      type: "stop_loss_limit",
      time_in_force: "good_till_time",
      reduce_only: true,
      trigger_price: "2900",
      order_expiry: 1_800_000_000_000,
      ...override,
    });
    const scope = buildLighterOrderEvidenceScope({
      approved: {
        accountIndex: 42,
        marketIndex: 0,
        side: "sell",
        orderType: "stop-loss-limit",
        timeInForce: "good-till-time",
        reduceOnly: true,
        baseAmountInteger: "10000",
        priceInteger: "200000",
        triggerPriceInteger: "290000",
      },
      baseDecimals: 4,
      priceDecimals: 2,
      signedOrderExpiryMs: 1_800_000_000_000,
    });
    expect(() => findMatchingLighterOrder([order], scope, "123456"))
      .toThrow("conflicts with the approved order semantics");
  });

  it("tolerates omitted optional provider semantics after exact price and size match", () => {
    const order = inactiveOrder({ side: undefined, is_ask: undefined });
    const scope = buildLighterOrderEvidenceScope({
      approved: {
        accountIndex: 42,
        marketIndex: 0,
        side: "buy",
        orderType: "limit",
        timeInForce: "good-till-time",
        reduceOnly: false,
        baseAmountInteger: "10000",
        priceInteger: "200000",
        triggerPriceInteger: null,
      },
      baseDecimals: 4,
      priceDecimals: 2,
      signedOrderExpiryMs: 1_800_000_000_000,
    });

    expect(lighterOrderMatchesEvidenceScope(order, scope)).toBe(true);
  });

  it("uses is_ask when Lighter returns a blank deprecated side field", () => {
    const order = inactiveOrder({ side: "", is_ask: false });
    const scope = buildLighterOrderEvidenceScope({
      approved: {
        accountIndex: 42,
        marketIndex: 0,
        side: "buy",
        orderType: "limit",
        timeInForce: "good-till-time",
        reduceOnly: false,
        baseAmountInteger: "10000",
        priceInteger: "200000",
        triggerPriceInteger: null,
      },
      baseDecimals: 4,
      priceDecimals: 2,
      signedOrderExpiryMs: 1_800_000_000_000,
    });

    expect(findMatchingLighterOrder([order], scope, "123456")).toBe(order);
    expect(lighterOrderMatchesEvidenceScope({ ...order, is_ask: true }, scope)).toBe(false);
  });

  it("compares nil IOC expiry exactly when the provider supplies it", () => {
    const scope = buildLighterOrderEvidenceScope({
      approved: {
        accountIndex: 42,
        marketIndex: 0,
        side: "buy",
        orderType: "limit",
        timeInForce: "immediate-or-cancel",
        reduceOnly: false,
        baseAmountInteger: "10000",
        priceInteger: "200000",
        triggerPriceInteger: null,
      },
      baseDecimals: 4,
      priceDecimals: 2,
      signedOrderExpiryMs: 0,
    });

    expect(lighterOrderMatchesEvidenceScope(inactiveOrder({ order_expiry: 0 }), scope)).toBe(true);
    expect(lighterOrderMatchesEvidenceScope(inactiveOrder({ order_expiry: 1_800_000_000_000 }), scope)).toBe(false);
  });

  it.each([
    { baseDecimals: 4, priceDecimals: 2, amount: "0.0983", price: "114.09", amountInteger: "983", priceInteger: "11409", quote: "10.992889", average: "111.83" },
    { baseDecimals: 5, priceDecimals: 1, amount: "0.00015", price: "100000.0", amountInteger: "15", priceInteger: "1000000", quote: "14.25", average: "95000" },
  ])("confirms a full fill using the original decimal amount at $baseDecimals size decimals", (example) => {
    const scope = buildLighterOrderEvidenceScope({
      approved: { accountIndex: 42, marketIndex: 0, side: "buy", orderType: "market",
        timeInForce: "immediate-or-cancel", reduceOnly: false, baseAmountInteger: example.amountInteger,
        priceInteger: example.priceInteger, triggerPriceInteger: null },
      baseDecimals: example.baseDecimals, priceDecimals: example.priceDecimals, signedOrderExpiryMs: 0,
    });
    const order = inactiveOrder({
      side: "", is_ask: false, type: "market", time_in_force: "immediate-or-cancel",
      initial_base_amount: example.amount, filled_base_amount: example.amount, remaining_base_amount: "0.0000",
      price: example.price, base_price: Number(example.priceInteger), base_size: 0,
      filled_quote_amount: example.quote, status: "filled", order_expiry: 0,
    });
    expect(findMatchingLighterOrder([order], scope, "123456")).toBe(order);
    expect(stateFromInactiveLighterOrder(order)).toBe("filled");
    expect(lighterOrderEvidenceJson("inactive_order", order, "123456")).toMatchObject({
      filledBaseAmount: example.amount, filledQuoteAmount: example.quote, averageExecutionPrice: example.average,
    });
    expect(findMatchingLighterOrder([{ ...order, client_order_id: "another-order" }], scope, "123456")).toBeNull();
    expect(findMatchingLighterOrder([{ ...order, owner_account_index: 99 }], scope, "123456")).toBeNull();
    expect(() => findMatchingLighterOrder([{ ...order, is_ask: true }], scope, "123456")).toThrow("is_ask");
    for (const amounts of [
      { filled_base_amount: "0" }, { filled_base_amount: "2" },
      { remaining_base_amount: "0.0001" }, { filled_base_amount: undefined },
    ]) {
      expect(() => findMatchingLighterOrder([{ ...order, ...amounts }], scope, "123456")).toThrow("filled_amounts");
    }
  });

  it("fails closed on duplicate provider identities", () => {
    const order = inactiveOrder();
    expect(() => findMatchingLighterOrder([order, { ...order, order_id: "988" }], {
      accountIndex: 42,
      marketIndex: 0,
      side: "buy",
    }, "123456")).toThrow("duplicate order evidence");
  });
});
