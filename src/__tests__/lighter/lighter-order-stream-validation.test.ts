import { describe, expect, it } from "vitest";

import { validateLighterAccountAllOrdersStreamMessage } from "@tools/lighter/validation.js";

function order(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_index: 987,
    client_order_index: 123456,
    order_id: "987",
    client_order_id: "123456",
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "1.0",
    price: "2000.00",
    status: "open",
    ...overrides,
  };
}

function frame(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "update/account_all_orders",
    channel: "account_all_orders:42",
    orders: { "0": [order()] },
    ...overrides,
  };
}

describe("Lighter account-all-orders stream validation", () => {
  it("accepts exact account-scoped order evidence while retaining string IDs", () => {
    const parsed = validateLighterAccountAllOrdersStreamMessage(frame(), 42);

    expect(parsed.orders["0"]?.[0]).toMatchObject({
      order_id: "987",
      client_order_id: "123456",
      owner_account_index: 42,
      market_index: 0,
    });
  });

  it("rejects a channel for a different account", () => {
    expect(() => validateLighterAccountAllOrdersStreamMessage(
      frame({ channel: "account_all_orders:43" }),
      42,
    )).toThrow("channel does not match");
  });

  it("rejects cross-account embedded orders", () => {
    expect(() => validateLighterAccountAllOrdersStreamMessage(frame({
      orders: { "0": [order({ owner_account_index: 43 })] },
    }), 42)).toThrow("order owner does not match");
  });

  it("rejects orders stored under a different market key", () => {
    expect(() => validateLighterAccountAllOrdersStreamMessage(frame({
      orders: { "1": [order({ market_index: 0 })] },
    }), 42)).toThrow("order market does not match");
  });

  it("rejects duplicate client-order IDs in one frame", () => {
    expect(() => validateLighterAccountAllOrdersStreamMessage(frame({
      orders: {
        "0": [order()],
        "1": [order({ order_index: 988, order_id: "988", market_index: 1 })],
      },
    }), 42)).toThrow("duplicate client order id");
  });

  it("rejects undocumented message types instead of inferring their meaning", () => {
    expect(() => validateLighterAccountAllOrdersStreamMessage(
      frame({ type: "subscribed/account_all_orders" }),
      42,
    )).toThrow("account all orders stream");
  });
});
