import { describe, expect, it } from "vitest";

import { lighterTradingAccountSchema } from "@shared/schemas/lighter-trading.js";
import type {
  LighterAccount,
  LighterAccountOrder,
  LighterAccountPosition,
} from "@tools/lighter/types.js";
import {
  findOwningLighterAccount,
  projectLighterTradingAccount,
  resolveUniqueLighterAccountIndex,
} from "../trading-account-service.js";

function position(overrides: Partial<LighterAccountPosition>): LighterAccountPosition {
  return {
    market_id: 1,
    symbol: "BTC",
    initial_margin_fraction: "0.1",
    open_order_count: 0,
    pending_order_count: 0,
    position_tied_order_count: 0,
    sign: 1,
    position: "1.5",
    avg_entry_price: "80000",
    position_value: "120000",
    unrealized_pnl: "250.5",
    realized_pnl: "0",
    liquidation_price: "60000",
    margin_mode: 0,
    allocated_margin: "12000",
    ...overrides,
  };
}

function order(overrides: Partial<LighterAccountOrder>): LighterAccountOrder {
  return {
    order_index: 1,
    client_order_index: 1,
    order_id: "9001",
    client_order_id: "c1",
    market_index: 1,
    owner_account_index: 42,
    initial_base_amount: "0.5",
    price: "79000",
    is_ask: false,
    remaining_base_amount: "0.5",
    type: "limit",
    status: "open",
    created_at: 1_720_000_000,
    ...overrides,
  };
}

const symbolFor = (marketId: number): string => (marketId === 1 ? "BTC" : `#${marketId}`);

describe("projectLighterTradingAccount", () => {
  it("projects positions, orders, and a summed unrealized PnL into a schema-valid DTO", () => {
    const account: LighterAccount = {
      account_index: 42,
      collateral: "50000",
      available_balance: "38000",
      positions: [
        position({ sign: 1, position: "1.5", unrealized_pnl: "250.5" }),
        position({ market_id: 2, symbol: "ETH", sign: -1, position: "10", unrealized_pnl: "-40.25" }),
      ],
    };

    const dto = projectLighterTradingAccount({
      environment: "rhc",
      accountIndex: 42,
      account,
      orders: [order({})],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1_720_000_100_000,
    });

    // Schema-valid output (guards the IPC outputSchema contract).
    expect(lighterTradingAccountSchema.safeParse(dto).success).toBe(true);
    expect(dto.status).toBe("ready");
    expect(dto.positions.map((p) => p.side)).toEqual(["long", "short"]);
    expect(dto.summary?.unrealizedPnl).toBe("210.25");
    expect(dto.openOrders).toHaveLength(1);
    expect(dto.openOrders[0]).toMatchObject({
      side: "buy",
      type: "limit",
      clientOrderId: "c1",
      price: "79000",
      timeInForce: null,
      reduceOnly: null,
      triggerPrice: null,
      triggerStatus: null,
      triggeredAt: null,
      orderExpiry: null,
      filled: null,
    });
    expect(dto.openOrdersTruncated).toBe(false);
  });

  it("surfaces held token balances (e.g. USDG) even when perp collateral is zero", () => {
    const account: LighterAccount = {
      account_index: 1171,
      collateral: "0",
      available_balance: "0",
      positions: [],
      assets: [
        {
          symbol: "USDG",
          asset_id: 3,
          balance: "125.5",
          locked_balance: "25.5",
          margin_balance: "0",
          margin_mode: "enabled",
          multiplier: "1",
        },
        {
          symbol: "ZERO",
          asset_id: 9,
          balance: "0",
          locked_balance: "0",
          margin_balance: "0",
          margin_mode: "disabled",
          multiplier: "1",
        },
      ],
    };

    const dto = projectLighterTradingAccount({
      environment: "rhc",
      accountIndex: 1171,
      account,
      orders: [],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(lighterTradingAccountSchema.safeParse(dto).success).toBe(true);
    // Zero-balance assets are dropped; USDG is surfaced with net-available.
    expect(dto.assets).toHaveLength(1);
    expect(dto.assets[0]).toMatchObject({
      symbol: "USDG",
      balance: "125.5",
      available: "100",
    });
  });

  it("keeps spot available balances exact beyond JavaScript number precision", () => {
    const dto = projectLighterTradingAccount({
      environment: "rhc",
      accountIndex: 1171,
      account: {
        account_index: 1171,
        positions: [],
        assets: [{
          symbol: "USDG",
          asset_id: 3,
          balance: "9007199254740993.00000001",
          locked_balance: "0.00000002",
          margin_balance: "0",
          margin_mode: "enabled",
          multiplier: "1",
        }],
      },
      orders: [],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.assets[0]?.available).toBe("9007199254740992.99999999");
  });

  it("binds account data only to the exact credential-owned account", () => {
    const requested = { index: 42, positions: [position({})] } satisfies LighterAccount;
    const unrelated = { account_index: 7, positions: [position({})] } satisfies LighterAccount;

    expect(findOwningLighterAccount([unrelated, requested], 42)).toBe(requested);
    expect(findOwningLighterAccount([unrelated], 42)).toBeNull();
  });

  it("refuses to guess between distinct unlocked accounts", () => {
    expect(resolveUniqueLighterAccountIndex([])).toBeNull();
    expect(resolveUniqueLighterAccountIndex([
      { accountIndex: 42 },
      { accountIndex: 43 },
    ])).toBeNull();
    expect(resolveUniqueLighterAccountIndex([
      { accountIndex: 42 },
      { accountIndex: 42 },
    ])).toBe(42);
  });

  it("sums unrealized PnL without IEEE-754 rounding", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 42,
      account: {
        account_index: 42,
        positions: [
          position({ market_id: 1, unrealized_pnl: "9007199254740993.00000001" }),
          position({ market_id: 2, unrealized_pnl: "-0.00000002" }),
        ],
      },
      orders: [],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.summary?.unrealizedPnl).toBe("9007199254740992.99999999");
  });

  it("drops flat positions and maps ask orders to the sell side", () => {
    const account: LighterAccount = {
      account_index: 7,
      positions: [
        position({ sign: 0, position: "0" }),
        position({ market_id: 2, symbol: "ETH", sign: -1, position: "2" }),
      ],
    };

    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 7,
      account,
      orders: [order({ owner_account_index: 7, is_ask: true, order_id: "5" })],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.positions).toHaveLength(1);
    expect(dto.positions[0]?.symbol).toBe("ETH");
    expect(dto.openOrders[0]?.side).toBe("sell");
  });

  it("drops provider rows whose side evidence is not canonical", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 7,
      account: {
        account_index: 7,
        positions: [position({ sign: 2, position: "2" })],
      },
      orders: [order({ owner_account_index: 7, is_ask: undefined, side: "unknown" })],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.positions).toEqual([]);
    expect(dto.openOrders).toEqual([]);
  });

  it("rejects impossible negative unsigned balances and order amounts", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 7,
      account: {
        account_index: 7,
        positions: [],
        assets: [{
          symbol: "USDG",
          asset_id: 3,
          balance: "-1",
          locked_balance: "0",
          margin_balance: "0",
          margin_mode: "enabled",
          multiplier: "1",
        }],
      },
      orders: [order({
        owner_account_index: 7,
        initial_base_amount: "-1",
        remaining_base_amount: "-1",
      })],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.assets).toEqual([]);
    expect(dto.openOrders[0]).toMatchObject({ size: null, remaining: null });
  });

  it("preserves exact renderer-safe details for every supported limit variant", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 42,
      account: { account_index: 42, positions: [] },
      orders: [
        order({
          order_id: "limit-order",
          client_order_id: "900719925474099312345",
          type: "limit",
          time_in_force: "post_only",
          reduce_only: false,
          filled_base_amount: "0.125",
          order_expiry: 1_720_000_500_000,
        }),
        order({
          order_id: "stop-limit-order",
          client_order_id: "stop-client",
          type: "stop_loss_limit",
          time_in_force: "good_till_time",
          reduce_only: true,
          trigger_price: "78000.25",
          trigger_status: "pending",
          order_expiry: 1_720_000_600_000,
        }),
        order({
          order_id: "take-profit-limit-order",
          client_order_id: "tp-client",
          type: "take_profit_limit",
          time_in_force: "immediate_or_cancel",
          reduce_only: true,
          trigger_price: "82000.75",
          trigger_status: "triggered",
          trigger_time: 1_720_000_650_000,
          order_expiry: 1_720_000_700_000,
        }),
      ],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.openOrders).toEqual([
      expect.objectContaining({
        orderId: "limit-order",
        clientOrderId: "900719925474099312345",
        type: "limit",
        timeInForce: "post_only",
        reduceOnly: false,
        triggerPrice: null,
        filled: "0.125",
        orderExpiry: 1_720_000_500_000,
      }),
      expect.objectContaining({
        orderId: "stop-limit-order",
        type: "stop_loss_limit",
        timeInForce: "good_till_time",
        reduceOnly: true,
        triggerPrice: "78000.25",
        triggerStatus: "pending",
        triggeredAt: null,
      }),
      expect.objectContaining({
        orderId: "take-profit-limit-order",
        type: "take_profit_limit",
        timeInForce: "immediate_or_cancel",
        reduceOnly: true,
        triggerPrice: "82000.75",
        triggerStatus: "triggered",
        triggeredAt: 1_720_000_650_000,
      }),
    ]);
    expect(lighterTradingAccountSchema.safeParse(dto).success).toBe(true);
  });

  it("never coerces a numeric client order identity into renderer output", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 42,
      account: { account_index: 42, positions: [] },
      orders: [order({ client_order_id: 9_007_199_254_740_993 as unknown as string })],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.openOrders[0]?.clientOrderId).toBeNull();
  });

  it("drops active-order rows that do not belong to the credential-bound account", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 42,
      account: { account_index: 42, positions: [] },
      orders: [
        order({ order_id: "owned", owner_account_index: 42 }),
        order({ order_id: "foreign", owner_account_index: 7 }),
      ],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(dto.openOrders.map((row) => row.orderId)).toEqual(["owned"]);
  });

  it("marks the bounded snapshot truncated for excess rows or a provider cursor", () => {
    const input = {
      environment: "core" as const,
      accountIndex: 42,
      account: { account_index: 42, positions: [] },
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    };
    const excessRows = Array.from({ length: 201 }, (_, index) => order({
      order_id: String(index + 1),
      client_order_id: `client-${index + 1}`,
    }));

    const excessDto = projectLighterTradingAccount({ ...input, orders: excessRows });
    const cursorDto = projectLighterTradingAccount({
      ...input,
      orders: [order({})],
      ordersNextCursor: "next-page",
    });

    expect(excessDto.openOrders).toHaveLength(200);
    expect(excessDto.openOrdersTruncated).toBe(true);
    expect(cursorDto.openOrdersTruncated).toBe(true);
  });

  it("omits open orders when the read-only authorization is unavailable", () => {
    const dto = projectLighterTradingAccount({
      environment: "rhc",
      accountIndex: 1,
      account: { account_index: 1, positions: [position({})] },
      orders: [order({})],
      openOrdersAvailable: false,
      symbolFor,
      now: () => 1,
    });

    expect(dto.openOrdersAvailable).toBe(false);
    expect(dto.openOrdersTruncated).toBe(false);
    expect(dto.openOrders).toHaveLength(0);
    expect(lighterTradingAccountSchema.safeParse(dto).success).toBe(true);
  });
});
