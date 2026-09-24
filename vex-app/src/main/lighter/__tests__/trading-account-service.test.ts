import { describe, expect, it, vi } from "vitest";

import {
  lighterTradingAccountSchema,
  lighterTradingFillsSchema,
} from "@shared/schemas/lighter-trading.js";
import type {
  LighterAccount,
  LighterAccountOrder,
  LighterAccountPosition,
  LighterTrade,
} from "@tools/lighter/types.js";
const secrets = vi.hoisted(() => ({
  listScopes: vi.fn<() => readonly { environment: string; accountIndex: number; apiKeyIndex: number }[]>(),
  vaultUnlocked: vi.fn<() => boolean>(),
  readOnlyAuth: vi.fn(),
  sessionAccount: vi.fn(),
}));

vi.mock("../session-account.js", () => ({
  resolveLighterSessionAccount: (...args: unknown[]) => secrets.sessionAccount(...args),
}));

vi.mock("../../secrets/lighter-trading-credential.js", () => ({
  listUnlockedLighterTradingCredentialScopes: () => secrets.listScopes(),
}));
vi.mock("../../secrets/session.js", () => ({
  requireUnlockedMasterPassword: () => (secrets.vaultUnlocked()
    ? { ok: true, data: "never-read-by-this-module" }
    : { ok: false, error: { code: "wallet.keystore_locked" } }),
}));
vi.mock("@vex-agent/tools/protocols/lighter/read-account-auth.js", () => ({
  resolveLighterReadOnlyAccountAuth: (...args: unknown[]) => secrets.readOnlyAuth(...args),
}));
vi.mock("../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../trading-panel-service.js", async (importActual) => ({
  ...(await importActual<typeof import("../trading-panel-service.js")>()),
  readLighterTradingMarketList: async () => ({ markets: [{ marketId: 1, symbol: "BTC" }] }),
}));

import {
  findOwningLighterAccount,
  projectLighterTradingAccount,
  projectLighterTradingFills,
  readLighterTradingAccount,
  readLighterTradingFills,
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
  it("keeps oversized provider labels and decimals inside the account DTO", () => {
    const dto = projectLighterTradingAccount({
      environment: "core",
      accountIndex: 42,
      account: {
        account_index: 42,
        collateral: "1".repeat(97),
        positions: [position({ symbol: "P".repeat(49) })],
        assets: [{ asset_id: 1, symbol: "A".repeat(49), balance: "1", locked_balance: "0", margin_balance: "0", margin_mode: "enabled", multiplier: "1" }],
      },
      orders: [],
      openOrdersAvailable: true,
      symbolFor,
      now: () => 1,
    });

    expect(lighterTradingAccountSchema.safeParse(dto).success).toBe(true);
    expect(dto.positions[0]?.symbol).toBe("#1");
    expect(dto.assets[0]?.symbol).toBe("#1");
    expect(dto.summary?.collateral).toBe(null);
  });

  it("projects positions, orders, and a summed unrealized PnL into a schema-valid DTO", () => {
    const account: LighterAccount = {
      account_index: 42,
      collateral: "50000",
      available_balance: "38000",
      positions: [
        position({ sign: 1, position: "1.5", unrealized_pnl: "250.5" }),
        position({
          market_id: 2, symbol: "ETH", sign: -1, position: "10", unrealized_pnl: "-40.25",
          initial_margin_fraction: "10.00", margin_mode: 1,
        }),
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
    // Margin terms travel with the row on the provider's 10000 scale
    // (the account endpoint's "10.00" percent is 1000, i.e. 10x).
    expect(dto.positions[0]).toMatchObject({ initialMarginFraction: 10, marginMode: "cross", allocatedMargin: "12000" });
    expect(dto.positions[1]).toMatchObject({ initialMarginFraction: 1000, marginMode: "isolated" });
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
    // The flat row still carries the account's own leverage for BTC.
    expect(dto.marginTerms).toEqual([
      { marketId: 1, initialMarginFraction: 10, marginMode: "cross" },
      { marketId: 2, initialMarginFraction: 10, marginMode: "cross" },
    ]);
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
      orders: [Object.defineProperty(order({}), "client_order_id", { value: 9_007_199_254_740_993 })],
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

describe("Lighter account read: why there is nothing to show", () => {
  const scope = { environment: "core" as const, accountIndex: 42, apiKeyIndex: 5 };
  const client = {
    getAccount: vi.fn(),
    getAccountActiveOrders: vi.fn(),
  };

  function reset(): void {
    vi.clearAllMocks();
    secrets.readOnlyAuth.mockResolvedValue(null);
  }

  it("separates a locked vault from an account that was never onboarded", async () => {
    // Both produce an empty scope list, and the panel used to show the same
    // "no account" copy for each. The person needs to know which one it is.
    reset();
    secrets.listScopes.mockReturnValue([]);
    secrets.vaultUnlocked.mockReturnValue(false);
    const locked = await readLighterTradingAccount("core", client, () => 1);
    expect(locked.status).toBe("unavailable");
    expect(locked.unavailableReason).toBe("locked_vault");

    secrets.vaultUnlocked.mockReturnValue(true);
    const empty = await readLighterTradingAccount("core", client, () => 1);
    expect(empty.unavailableReason).toBe("not_onboarded");

    expect(client.getAccount).not.toHaveBeenCalled();
    expect(lighterTradingAccountSchema.safeParse(locked).success).toBe(true);
    expect(lighterTradingAccountSchema.safeParse(empty).success).toBe(true);
  });

  it("refuses to pick between several onboarded accounts and says so", async () => {
    reset();
    secrets.vaultUnlocked.mockReturnValue(true);
    secrets.listScopes.mockReturnValue([scope, { ...scope, accountIndex: 43 }]);

    const result = await readLighterTradingAccount("core", client, () => 1);

    expect(result.unavailableReason).toBe("ambiguous_account");
    expect(client.getAccount).not.toHaveBeenCalled();
  });

  it("tells a failed orders read apart from a missing read-only authorization", async () => {
    reset();
    secrets.vaultUnlocked.mockReturnValue(true);
    secrets.listScopes.mockReturnValue([scope]);
    client.getAccount.mockResolvedValue({ accounts: [{ account_index: 42, positions: [] }] });

    const noAuth = await readLighterTradingAccount("core", client, () => 1);
    expect(noAuth.openOrdersAvailable).toBe(false);
    expect(noAuth.openOrdersUnavailableReason).toBe("no_read_auth");

    secrets.readOnlyAuth.mockResolvedValue({ authorization: "token" });
    client.getAccountActiveOrders.mockRejectedValue(new Error("provider 503"));
    const failed = await readLighterTradingAccount("core", client, () => 1);
    expect(failed.status).toBe("ready");
    expect(failed.openOrdersAvailable).toBe(false);
    expect(failed.openOrdersUnavailableReason).toBe("read_failed");

    client.getAccountActiveOrders.mockResolvedValue({ orders: [] });
    const ok = await readLighterTradingAccount("core", client, () => 1);
    expect(ok.openOrdersAvailable).toBe(true);
    expect(ok.openOrdersUnavailableReason).toBeUndefined();
    expect(lighterTradingAccountSchema.safeParse(failed).success).toBe(true);
  });

  it("carries the account's own fee tier, and a ceiling rather than the market fee when it cannot be read", async () => {
    // Account 31824 paid a 0.035% Premium taker tier on markets whose
    // published fee read 0; the ticket sized on the 0 and Lighter cancelled
    // every 100% order.
    reset();
    secrets.vaultUnlocked.mockReturnValue(true);
    secrets.listScopes.mockReturnValue([scope]);
    secrets.readOnlyAuth.mockResolvedValue({ authorization: "token" });
    client.getAccount.mockResolvedValue({ accounts: [{ account_index: 42, positions: [] }] });
    client.getAccountActiveOrders.mockResolvedValue({ orders: [] });
    const getAccountLimits = vi.fn().mockResolvedValue({
      code: 200,
      user_tier: "premium",
      user_tier_name: "Premium",
      current_maker_fee_tick: 120,
      current_taker_fee_tick: 350,
    });

    const read = await readLighterTradingAccount("core", { ...client, getAccountLimits }, () => 1);
    expect(read.exchangeFees).toEqual({ makerTicks: 120, takerTicks: 350, source: "account" });
    expect(lighterTradingAccountSchema.safeParse(read).success).toBe(true);

    getAccountLimits.mockRejectedValue(new Error("provider 503"));
    const unread = await readLighterTradingAccount("core", { ...client, getAccountLimits }, () => 1);
    expect(unread.status).toBe("ready");
    expect(unread.exchangeFees?.source).toBe("assumed_ceiling");
    expect(unread.exchangeFees?.takerTicks).toBeGreaterThan(350);
  });

  it("selects only the session wallet's account when other accounts have saved keys", async () => {
    reset();
    secrets.listScopes.mockReturnValue([scope, { ...scope, accountIndex: 43 }]);
    secrets.sessionAccount.mockResolvedValueOnce(43);
    client.getAccount.mockResolvedValueOnce({ accounts: [
      { account_index: 42, positions: [position({})] },
      { account_index: 43, positions: [] },
    ] });

    const result = await readLighterTradingAccount("core", client, () => 1, undefined, "wallet-b-session");

    expect(secrets.sessionAccount).toHaveBeenCalledWith({ sessionId: "wallet-b-session", environment: "core", signal: undefined });
    expect(client.getAccount).toHaveBeenCalledWith("core", { by: "index", value: 43 }, { signal: undefined });
    expect(result.accountIndex).toBe(43);
    expect(result.positions).toEqual([]);
    expect(secrets.readOnlyAuth).toHaveBeenCalledWith("core", 43);
  });

  it.each(["missing wallet", "no matching key"])("never falls back to another account for a session with %s", async (scenario) => {
    reset();
    secrets.listScopes.mockReturnValue([scope]);
    if (scenario === "missing wallet") secrets.sessionAccount.mockRejectedValueOnce(new Error("No wallet selected"));
    else secrets.sessionAccount.mockResolvedValueOnce(43);

    const read = readLighterTradingAccount("core", client, () => 1, undefined, "wallet-b-session");
    if (scenario === "missing wallet") await expect(read).rejects.toThrow("No wallet selected");
    else await expect(read).resolves.toMatchObject({ status: "unavailable", unavailableReason: "not_onboarded", accountIndex: null });
    expect(client.getAccount).not.toHaveBeenCalled();
    expect(secrets.readOnlyAuth).not.toHaveBeenCalled();
  });

  it("stops before the provider read when the caller already abandoned it", async () => {
    reset();
    secrets.vaultUnlocked.mockReturnValue(true);
    secrets.listScopes.mockReturnValue([scope]);
    const controller = new AbortController();
    controller.abort();

    await expect(
      readLighterTradingAccount("core", client, () => 1, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(client.getAccount).not.toHaveBeenCalled();
  });
});

function trade(overrides: Partial<LighterTrade>): LighterTrade {
  return {
    trade_id: 7,
    trade_id_str: "7",
    tx_hash: "0xabc",
    type: "trade",
    market_id: 1,
    size: "0.25",
    price: "80000",
    usd_amount: "20000",
    ask_id: 1,
    ask_id_str: "1",
    bid_id: 2,
    bid_id_str: "2",
    ask_account_id: 99,
    bid_account_id: 42,
    is_maker_ask: true,
    block_height: 1,
    timestamp: 1_720_000_000_000,
    ask_account_pnl: "-5",
    bid_account_pnl: "12.5",
    ...overrides,
  };
}

describe("projectLighterTradingFills", () => {
  it("keeps one oversized provider label from invalidating the fills DTO", () => {
    const fills = projectLighterTradingFills({
      environment: "core",
      accountIndex: 42,
      trades: [Object.defineProperty(trade({}), "type", { value: "x".repeat(33) })],
      symbolFor: () => "S".repeat(49),
      now: () => 5,
    });

    expect(lighterTradingFillsSchema.safeParse(fills).success).toBe(true);
    expect(fills.fills[0]).toMatchObject({ symbol: "#1", type: "trade" });
  });

  it("reads side, role and realized PnL from the account's own side of the fill", () => {
    const fills = projectLighterTradingFills({
      environment: "core",
      accountIndex: 42,
      trades: [
        trade({}),
        trade({ trade_id_str: "8", ask_account_id: 42, bid_account_id: 99, is_maker_ask: false, type: "liquidation", timestamp: 1_720_000_001_000 }),
      ],
      symbolFor,
      now: () => 5,
    });

    expect(lighterTradingFillsSchema.safeParse(fills).success).toBe(true);
    expect(fills.available).toBe(true);
    // Newest first, whatever order the provider answered in.
    expect(fills.fills.map((row) => row.tradeId)).toEqual(["8", "7"]);
    expect(fills.fills[1]).toMatchObject({
      symbol: "BTC",
      orderId: "2",
      side: "buy",
      role: "taker",
      type: "trade",
      value: "20000",
      realizedPnl: "12.5",
    });
    expect(fills.fills[0]).toMatchObject({ orderId: "1", side: "sell", role: "taker", type: "liquidation", realizedPnl: "-5" });
  });

  it("drops rows the account is not on exactly one side of", () => {
    const fills = projectLighterTradingFills({
      environment: "core",
      accountIndex: 42,
      trades: [
        trade({ ask_account_id: 1, bid_account_id: 2 }),
        trade({ ask_account_id: 42, bid_account_id: 42 }),
      ],
      symbolFor,
      now: () => 5,
    });
    expect(fills.fills).toEqual([]);
  });
});

describe("readLighterTradingFills", () => {
  const scope = { environment: "core" as const, accountIndex: 42, apiKeyIndex: 5 };
  const client = { getAccountTrades: vi.fn() };

  it("reads fills only for the session wallet's resolved account among multiple saved accounts", async () => {
    vi.clearAllMocks();
    secrets.listScopes.mockReturnValue([scope, { ...scope, accountIndex: 43 }]);
    secrets.sessionAccount.mockResolvedValueOnce(43);
    secrets.readOnlyAuth.mockResolvedValueOnce({ accountIndex: 43, token: "read-only" });
    client.getAccountTrades.mockResolvedValueOnce({ trades: [] });

    const fills = await readLighterTradingFills("core", 20, client, () => 1, undefined, "wallet-b-session");

    expect(fills.accountIndex).toBe(43);
    expect(secrets.readOnlyAuth).toHaveBeenCalledWith("core", 43);
    expect(client.getAccountTrades).toHaveBeenCalledWith("core", { accountIndex: 43, limit: 20, sortBy: "timestamp" },
      { accountIndex: 43, token: "read-only" }, { signal: undefined });
  });

  it.each(["missing wallet", "no matching key"])("does not read another account's fills for %s", async (scenario) => {
    vi.clearAllMocks();
    secrets.listScopes.mockReturnValue([scope]);
    if (scenario === "missing wallet") secrets.sessionAccount.mockRejectedValueOnce(new Error("No wallet selected"));
    else secrets.sessionAccount.mockResolvedValueOnce(43);

    const read = readLighterTradingFills("core", 20, client, () => 1, undefined, "wallet-b-session");
    if (scenario === "missing wallet") await expect(read).rejects.toThrow("No wallet selected");
    else await expect(read).resolves.toMatchObject({ available: false, accountIndex: null, fills: [] });
    expect(client.getAccountTrades).not.toHaveBeenCalled();
    expect(secrets.readOnlyAuth).not.toHaveBeenCalled();
  });

  it("reports unavailable without a provider read when no read-only auth can be derived", async () => {
    vi.clearAllMocks();
    secrets.listScopes.mockReturnValue([scope]);
    secrets.readOnlyAuth.mockResolvedValue(null);

    const fills = await readLighterTradingFills("core", 20, client, () => 1);

    expect(fills).toEqual({ environment: "core", retrievedAt: 1, accountIndex: 42, available: false, truncated: false, fills: [] });
    expect(client.getAccountTrades).not.toHaveBeenCalled();
  });

  it("reads the bound account's trades with the derived auth and the caller's signal", async () => {
    vi.clearAllMocks();
    secrets.listScopes.mockReturnValue([scope]);
    const auth = { accountIndex: 42, token: "never-crosses" };
    secrets.readOnlyAuth.mockResolvedValue(auth);
    client.getAccountTrades.mockResolvedValue({ trades: [trade({})] });
    const controller = new AbortController();

    const fills = await readLighterTradingFills("core", 20, client, () => 1, controller.signal);

    expect(client.getAccountTrades).toHaveBeenCalledWith(
      "core",
      { accountIndex: 42, limit: 20, sortBy: "timestamp" },
      auth,
      { signal: controller.signal },
    );
    expect(fills.fills).toHaveLength(1);
    expect(fills.fills[0]?.symbol).toBe("BTC");
    expect(fills.truncated).toBe(false);
  });

  it("marks a bounded provider page incomplete when more fills are available", async () => {
    vi.clearAllMocks();
    secrets.listScopes.mockReturnValue([scope]);
    const auth = { accountIndex: 42, token: "never-crosses" };
    secrets.readOnlyAuth.mockResolvedValue(auth);
    client.getAccountTrades.mockResolvedValue({ trades: [trade({})], next_cursor: "next" });

    const fills = await readLighterTradingFills("core", 20, client, () => 1);

    expect(fills.truncated).toBe(true);
  });
});
