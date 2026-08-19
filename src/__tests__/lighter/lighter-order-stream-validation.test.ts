import { describe, expect, it } from "vitest";

import {
  validateLighterAccountAllOrdersStreamMessage,
  validateLighterAccountAllPositionsStreamMessage,
  validateLighterAccountAllTradesStreamMessage,
} from "@tools/lighter/validation.js";

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

describe("Lighter account-all-trades stream validation", () => {
  const trade = {
    trade_id: 1001,
    trade_id_str: "1001",
    tx_hash: "0xtrade",
    type: "trade",
    market_id: 0,
    size: "0.25",
    price: "2000.00",
    usd_amount: "500.00",
    ask_id: 987,
    ask_id_str: "987",
    bid_id: 988,
    bid_id_str: "988",
    ask_client_id: 123456,
    ask_client_id_str: "123456",
    bid_client_id: 654321,
    bid_client_id_str: "654321",
    ask_account_id: 42,
    bid_account_id: 43,
    is_maker_ask: true,
    block_height: 99,
    timestamp: 1_800_000_000_000,
  };

  it("accepts exact account-scoped trade maps while retaining string IDs", () => {
    const parsed = validateLighterAccountAllTradesStreamMessage({
      type: "update/account_all_trades",
      channel: "account_all_trades:42",
      trades: { "0": [trade] },
    }, 42);

    expect(Array.isArray(parsed.trades)).toBe(false);
    expect((parsed.trades as Record<string, typeof trade[]>)["0"]?.[0]?.ask_client_id_str).toBe("123456");
  });

  it("accepts the documented initial empty trade snapshot", () => {
    expect(validateLighterAccountAllTradesStreamMessage({
      type: "subscribed/account_all_trades",
      channel: "account_all_trades:42",
      trades: [],
      total_volume: 0,
      monthly_volume: 0,
      weekly_volume: 0,
      daily_volume: 0,
    }, 42).trades).toEqual([]);
  });

  it("rejects trades outside the expected account or market", () => {
    expect(() => validateLighterAccountAllTradesStreamMessage({
      type: "update/account_all_trades",
      channel: "account_all_trades:42",
      trades: { "1": [trade] },
    }, 42)).toThrow("trade market does not match");
    expect(() => validateLighterAccountAllTradesStreamMessage({
      type: "update/account_all_trades",
      channel: "account_all_trades:42",
      trades: { "0": [{ ...trade, ask_account_id: 40, bid_account_id: 41 }] },
    }, 42)).toThrow("trade does not involve");
  });
});

describe("Lighter account-all-positions stream validation", () => {
  const position = {
    market_id: 0,
    symbol: "ETH",
    initial_margin_fraction: "0.05",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 1,
    position: "0.25",
    avg_entry_price: "2000.00",
    position_value: "500.00",
    unrealized_pnl: "10.00",
    realized_pnl: "0.00",
    liquidation_price: "1500.00",
    margin_mode: 0,
    allocated_margin: "25.00",
  };

  it("accepts the documented position snapshot with omitted optional discounts", () => {
    const parsed = validateLighterAccountAllPositionsStreamMessage({
      type: "subscribed/account_all_positions",
      channel: "account_all_positions:42",
      positions: { "0": position },
      shares: [],
    }, 42);

    expect(parsed.positions["0"]?.position).toBe("0.25");
  });

  it("rejects a position under the wrong market key", () => {
    expect(() => validateLighterAccountAllPositionsStreamMessage({
      type: "update/account_all_positions",
      channel: "account_all_positions:42",
      positions: { "1": position },
      shares: [],
    }, 42)).toThrow("position market does not match");
  });
});
