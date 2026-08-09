import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type {
  LighterAccount,
  LighterAccountOrder,
  LighterCandle,
  LighterMarket,
  LighterMarketDetail,
  LighterSimpleOrder,
  LighterTrade,
} from "@tools/lighter/types.js";

const mocks = vi.hoisted(() => ({
  client: {
    getStatus: vi.fn(),
    getSystemConfig: vi.fn(),
    getMarkets: vi.fn(),
    getMarketDetails: vi.fn(),
    getAccount: vi.fn(),
    getAccountActiveOrders: vi.fn(),
    getAccountInactiveOrders: vi.fn(),
    getAccountTrades: vi.fn(),
    getOrderBookOrders: vi.fn(),
    getRecentTrades: vi.fn(),
    getCandles: vi.fn(),
  },
  logger: {
    warn: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@tools/lighter/client.js", () => ({
  getLighterClient: () => mocks.client,
}));

vi.mock("@utils/logger.js", () => ({
  default: mocks.logger,
}));

const { LIGHTER_HANDLERS } = await import("@vex-agent/tools/protocols/lighter/handlers.js");
const { projectAccountOrders } = await import("@vex-agent/tools/protocols/lighter/projectors.js");
const { executeProtocolTool } = await import("@vex-agent/tools/protocols/runtime.js");

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

const UNSAFE_INTEGER = Number.MAX_SAFE_INTEGER + 1;
const UNSAFE_INTEGER_2 = Number.MAX_SAFE_INTEGER + 3;

const MARKET: LighterMarket = {
  symbol: "ETH-USD",
  market_id: 0,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 0,
  status: "active",
  taker_fee: "0.0003",
  maker_fee: "0.0001",
  liquidation_fee: "0.01",
  min_base_amount: "0.001",
  min_quote_amount: "10",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "100000",
  is_maker_fee_enabled: true,
  is_taker_fee_enabled: true,
};

const DETAIL: LighterMarketDetail = {
  ...MARKET,
  last_trade_price: 3500,
  daily_trades_count: 42,
  daily_base_token_volume: 10,
  daily_quote_token_volume: 35000,
  daily_price_low: 3400,
  daily_price_high: 3600,
  daily_price_change: 2.5,
  open_interest: 12345,
  size_decimals: 4,
  price_decimals: 2,
  quote_multiplier: 1,
  strategy_index: 7,
  funding_clamp_small: "0.001",
  funding_clamp_big: "0.005",
  base_interest_rate: "0.02",
};

const ACCOUNT: LighterAccount = {
  index: 42,
  l1_address: "0x1111111111111111111111111111111111111111",
  status: 1,
  collateral: "1000",
  available_balance: "750",
  positions: [
    { market_id: 0, symbol: "ETH", position: "1.25", avg_entry_price: "3000" },
  ],
  assets: [
    { asset_id: 1, symbol: "USDC", balance: "750" },
  ],
};

function order(id: number, price: string): LighterSimpleOrder {
  return {
    order_index: id,
    order_id: `order-${id}`,
    owner_account_index: 100 + id,
    initial_base_amount: "1",
    remaining_base_amount: "0.5",
    price,
    order_expiry: 1786233600000,
    transaction_time: 1786147200000 + id,
  };
}

function trade(id: number): LighterTrade {
  return {
    trade_id: id,
    trade_id_str: String(id),
    tx_hash: `0x${id}`,
    type: "trade",
    market_id: 0,
    size: "0.25",
    price: "3500",
    usd_amount: "875",
    ask_id: 10,
    ask_id_str: "10",
    bid_id: 11,
    bid_id_str: "11",
    ask_account_id: 12,
    bid_account_id: 13,
    is_maker_ask: true,
    block_height: 99,
    timestamp: 1786147200000 + id,
    transaction_time: 1786147200000 + id,
  };
}

function accountOrder(): LighterAccountOrder {
  return {
    order_index: UNSAFE_INTEGER,
    client_order_index: UNSAFE_INTEGER_2,
    order_id: String(UNSAFE_INTEGER),
    client_order_id: String(UNSAFE_INTEGER_2),
    market_index: 0,
    owner_account_index: 42,
    initial_base_amount: "100",
    remaining_base_amount: "50",
    filled_base_amount: "50",
    filled_quote_amount: "15000000",
    price: "300000",
    side: "buy",
    type: "limit",
    time_in_force: "good_till_time",
    reduce_only: false,
    order_expiry: 1786233600000,
    status: "open",
    timestamp: 1786147200000,
    created_at: 1786147200000,
    updated_at: 1786147200001,
    transaction_time: 1786147200000,
  };
}

function candle(index: number): LighterCandle {
  return {
    t: 1786147200000 + index * 60_000,
    o: index,
    h: index + 1,
    l: index - 1,
    c: index + 0.5,
    v: index * 2,
    V: index * 2000,
    i: index,
  };
}

async function callJson(toolId: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const handler = LIGHTER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`missing handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success, result.output).toBe(true);
  return JSON.parse(result.output) as Record<string, unknown>;
}

async function callFail(toolId: string, params: Record<string, unknown>): Promise<string> {
  const handler = LIGHTER_HANDLERS[toolId];
  if (handler === undefined) throw new Error(`missing handler for ${toolId}`);
  const result = await handler(params, READ_CTX);
  expect(result.success).toBe(false);
  return result.output;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Lighter agent read handlers", () => {
  it("reads system status and config for the requested environment", async () => {
    mocks.client.getStatus.mockResolvedValue({
      status: 200,
      network_id: 4663,
      timestamp: 1786147200000,
    });
    mocks.client.getSystemConfig.mockResolvedValue({
      code: 200,
      message: "ok",
      liquidity_pool_index: 1,
      staking_pool_index: 2,
      funding_fee_rebate_account_index: 3,
      market_maker_incentive_account_index: 4,
      liquidity_pool_cooldown_period: 5,
      staking_pool_lockup_period: 6,
      max_integrator_perps_maker_fee: 7,
      max_integrator_perps_taker_fee: 8,
      max_integrator_spot_maker_fee: 9,
      max_integrator_spot_taker_fee: 10,
    });

    const data = await callJson("lighter.system", { environment: "rhc" });

    expect(mocks.client.getStatus).toHaveBeenCalledWith("rhc");
    expect(mocks.client.getSystemConfig).toHaveBeenCalledWith("rhc");
    expect(data.environment).toBe("rhc");
    expect((data.status as Record<string, unknown>).networkId).toBe(4663);
    expect((data.systemConfig as Record<string, unknown>).liquidityPoolIndex).toBe(1);
  });

  it("lists markets with deterministic ordering, paging, and bounded output", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        { ...MARKET, market_id: 56, symbol: "ZK" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD", status: "inactive" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD" },
        { ...MARKET, market_id: 1, symbol: "BTC-USD" },
        MARKET,
      ],
    });

    const data = await callJson("lighter.markets", {
      environment: "core",
      filter: "perp",
      limit: 2,
      page: 1,
    });

    expect(mocks.client.getMarkets).toHaveBeenCalledWith("core", { filter: "perp" });
    expect(data.count).toBe(2);
    expect(data.totalProviderRows).toBe(5);
    expect(data.truncated).toBe(true);
    expect(data.lastPage).toBe(3);
    expect(data.nextPage).toBe(2);
    expect(data.sorting).toEqual({ markets: "active_first_market_id_ascending" });
    expect(data.truncationNote).toContain("Request page 2");
    expect((data.markets as Record<string, unknown>[]).map((market) => market.symbol)).toEqual([
      "ETH-USD",
      "BTC-USD",
    ]);
  });

  it("rejects a market page past the live result set", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        MARKET,
        { ...MARKET, market_id: 1, symbol: "BTC-USD" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD" },
      ],
    });

    const output = await callFail("lighter.markets", {
      environment: "core",
      limit: 2,
      page: 10,
    });

    expect(output).toContain("page 10 is past the last page (2)");
    expect(output).toContain("Request page 2 or lower");
  });

  it("gets one market detail and refuses a missing market cleanly", async () => {
    mocks.client.getMarketDetails.mockResolvedValueOnce({
      code: 200,
      order_book_details: [DETAIL],
      spot_order_book_details: [],
    });

    const data = await callJson("lighter.market.get", {
      environment: "rhc",
      marketId: 0,
      filter: "all",
    });

    expect(mocks.client.getMarketDetails).toHaveBeenCalledWith("rhc", { marketId: 0, filter: "all" });
    expect(data.count).toBe(1);
    expect((data.details as Record<string, unknown>[])[0]?.lastTradePrice).toBe(3500);

    mocks.client.getMarketDetails.mockResolvedValueOnce({
      code: 200,
      order_book_details: [],
      spot_order_book_details: [],
    });
    const output = await callFail("lighter.market.get", { environment: "rhc", marketId: 999 });
    expect(output).toContain("No Lighter market detail found");
  });

  it("reads public account state by account index without credentials", async () => {
    mocks.client.getAccount.mockResolvedValue({
      code: 200,
      total: 1,
      accounts: [ACCOUNT],
    });

    const data = await callJson("lighter.account.get", {
      environment: "rhc",
      accountIndex: 42,
      activeOnly: true,
    });

    expect(mocks.client.getAccount).toHaveBeenCalledWith("rhc", {
      by: "index",
      value: 42,
      activeOnly: true,
    });
    expect((data.provenance as Record<string, unknown>).authenticated).toBe(false);
    expect(data.count).toBe(1);
    const account = (data.accounts as Record<string, unknown>[])[0]!;
    expect(account.accountIndex).toBe(42);
    expect(account.positionCount).toBe(1);
  });

  it("reads public positions by l1 address", async () => {
    mocks.client.getAccount.mockResolvedValue({
      code: 200,
      total: 1,
      accounts: [ACCOUNT],
    });

    const data = await callJson("lighter.positions", {
      environment: "core",
      l1Address: "0x1111111111111111111111111111111111111111",
    });

    expect(mocks.client.getAccount).toHaveBeenCalledWith("core", {
      by: "l1_address",
      value: "0x1111111111111111111111111111111111111111",
      activeOnly: undefined,
    });
    const account = (data.accounts as Record<string, unknown>[])[0]!;
    expect(account.count).toBe(1);
    expect(account.positions).toEqual(ACCOUNT.positions);
  });

  it("rejects ambiguous account lookup params before reaching the client", async () => {
    const output = await callFail("lighter.account.get", {
      environment: "core",
      accountIndex: 42,
      l1Address: "0x1111111111111111111111111111111111111111",
    });

    expect(output).toContain("Provide either accountIndex or l1Address, not both");
    expect(mocks.client.getAccount).not.toHaveBeenCalled();
  });

  it("reads authenticated open orders with credential-defaulted account provenance", async () => {
    mocks.client.getAccountActiveOrders.mockResolvedValue({
      code: 200,
      orders: [accountOrder()],
    });

    const data = await callJson("lighter.openOrders", {
      environment: "rhc",
      marketId: 0,
      filter: "perp",
      limit: 1,
    });

    expect(mocks.client.getAccountActiveOrders).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      marketType: "perp",
    });
    expect(data.source).toBe("live_lighter_read_only_account_api");
    expect((data.provenance as Record<string, unknown>).authenticated).toBe(true);
    expect((data.provenance as Record<string, unknown>).credentialCapability).toBe("read_only_account_data");
    expect(data.accountIndexSource).toBe("credential");
    const order = (data.orders as Record<string, unknown>[])[0]!;
    expect(order.orderIndex).toBe(String(UNSAFE_INTEGER));
    expect(order.clientOrderIndex).toBe(String(UNSAFE_INTEGER_2));
  });

  it("reads authenticated order history for an explicit account", async () => {
    mocks.client.getAccountInactiveOrders.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      orders: [accountOrder(), { ...accountOrder(), order_id: "2", client_order_id: "3" }],
    });

    const data = await callJson("lighter.orderHistory", {
      environment: "core",
      accountIndex: 42,
      limit: 1,
    });

    expect(mocks.client.getAccountInactiveOrders).toHaveBeenCalledWith("core", {
      accountIndex: 42,
      limit: 1,
    });
    expect(data.accountIndexSource).toBe("caller");
    expect(data.accountIndex).toBe(42);
    expect(data.truncated).toBe(true);
    expect(data.nextCursor).toBe("cursor-1");
    expect((data.orders as Record<string, unknown>[])).toHaveLength(1);
  });

  it("reads authenticated account trades with exact trade ids", async () => {
    const unsafeTrade: LighterTrade = {
      ...trade(1),
      trade_id: UNSAFE_INTEGER,
      trade_id_str: String(UNSAFE_INTEGER),
      ask_id: UNSAFE_INTEGER,
      ask_id_str: String(UNSAFE_INTEGER),
      bid_id: UNSAFE_INTEGER_2,
      bid_id_str: String(UNSAFE_INTEGER_2),
    };
    mocks.client.getAccountTrades.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      trades: [unsafeTrade],
    });

    const data = await callJson("lighter.trades", {
      environment: "rhc",
      accountIndex: 42,
      limit: 1,
    });

    expect(mocks.client.getAccountTrades).toHaveBeenCalledWith("rhc", {
      accountIndex: 42,
      limit: 1,
      sortBy: "timestamp",
    });
    expect(data.source).toBe("live_lighter_read_only_account_api");
    const fill = (data.trades as Record<string, unknown>[])[0]!;
    expect(fill.tradeId).toBe(String(UNSAFE_INTEGER));
    expect(fill.tradeIdNumeric).toBeNull();
    expect(fill.askOrderId).toBe(String(UNSAFE_INTEGER));
    expect(fill.bidOrderId).toBe(String(UNSAFE_INTEGER_2));
  });

  it("sorts order book orders into best price order before truncating", async () => {
    const asks = Object.freeze([
      order(1, "3503"),
      { ...order(2, "3501"), order_index: UNSAFE_INTEGER, order_id: String(UNSAFE_INTEGER) },
      order(3, "3502"),
    ]);
    const bids = Object.freeze([
      order(4, "3498"),
      { ...order(5, "3500"), order_index: UNSAFE_INTEGER_2, order_id: String(UNSAFE_INTEGER_2) },
      order(6, "3499"),
    ]);
    mocks.client.getOrderBookOrders.mockResolvedValue({
      code: 200,
      total_asks: 3,
      asks,
      total_bids: 3,
      bids,
    });

    const data = await callJson("lighter.orderbook", {
      environment: "rhc",
      marketId: 0,
      limit: 2,
    });

    expect(mocks.client.getOrderBookOrders).toHaveBeenCalledWith("rhc", { marketId: 0, limit: 2 });
    expect(data.shownAsks).toBe(2);
    expect(data.shownBids).toBe(2);
    expect(data.asksTruncated).toBe(true);
    expect(data.bidsTruncated).toBe(true);
    expect(data.sorting).toEqual({
      asks: "price_ascending",
      bids: "price_descending",
    });
    const projectedAsks = data.asks as Record<string, unknown>[];
    const projectedBids = data.bids as Record<string, unknown>[];
    expect(projectedAsks.map((row) => row.price)).toEqual(["3501", "3502"]);
    expect(projectedBids.map((row) => row.price)).toEqual(["3500", "3499"]);
    expect(projectedAsks[0]?.orderIndex).toBeNull();
    expect(projectedAsks[0]?.orderIndexPrecision).toBe("unsafe_provider_number_omitted");
    expect(projectedBids[0]?.orderIndex).toBeNull();
    expect(projectedBids[0]?.orderIndexPrecision).toBe("unsafe_provider_number_omitted");
  });

  it("reads recent trades with bounded rows and next cursor disclosure", async () => {
    const unsafeTrade: LighterTrade = {
      ...trade(1),
      trade_id: UNSAFE_INTEGER,
      trade_id_str: String(UNSAFE_INTEGER),
      ask_id: UNSAFE_INTEGER,
      ask_id_str: String(UNSAFE_INTEGER),
      bid_id: UNSAFE_INTEGER_2,
      bid_id_str: String(UNSAFE_INTEGER_2),
    };
    mocks.client.getRecentTrades.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      trades: [unsafeTrade, trade(2), trade(3)],
    });

    const data = await callJson("lighter.recentTrades", {
      environment: "core",
      marketId: 0,
      limit: 2,
    });

    expect(mocks.client.getRecentTrades).toHaveBeenCalledWith("core", { marketId: 0, limit: 2 });
    expect(data.count).toBe(2);
    expect(data.totalProviderRows).toBe(3);
    expect(data.truncated).toBe(true);
    expect(data.nextCursor).toBe("cursor-1");
    const first = (data.trades as Record<string, unknown>[])[0]!;
    expect(first.tradeId).toBe(String(UNSAFE_INTEGER));
    expect(first.tradeIdPrecision).toBe("provider_string_canonical");
    expect(first.tradeIdNumeric).toBeNull();
    expect(first.tradeIdNumericPrecision).toBe("unsafe_provider_number_omitted");
    expect(first.askOrderId).toBe(String(UNSAFE_INTEGER));
    expect(first.askOrderIdNumeric).toBeNull();
    expect(first.askOrderIdNumericPrecision).toBe("unsafe_provider_number_omitted");
    expect(first.bidOrderId).toBe(String(UNSAFE_INTEGER_2));
    expect(first.bidOrderIdNumeric).toBeNull();
    expect(first.bidOrderIdNumericPrecision).toBe("unsafe_provider_number_omitted");
  });

  it("projects account order identifiers as exact provider strings", () => {
    const data = projectAccountOrders({
      code: 200,
      next_cursor: "cursor-1",
      orders: [accountOrder()],
    }, 1);

    const first = data.orders[0] as Record<string, unknown>;
    expect(data.nextCursor).toBe("cursor-1");
    expect(first.orderIndex).toBe(String(UNSAFE_INTEGER));
    expect(first.orderIndexPrecision).toBe("provider_string_canonical");
    expect(first.orderIndexNumeric).toBeNull();
    expect(first.orderIndexNumericPrecision).toBe("unsafe_provider_number_omitted");
    expect(first.clientOrderIndex).toBe(String(UNSAFE_INTEGER_2));
    expect(first.clientOrderIndexPrecision).toBe("provider_string_canonical");
    expect(first.clientOrderIndexNumeric).toBeNull();
    expect(first.clientOrderIndexNumericPrecision).toBe("unsafe_provider_number_omitted");
  });

  it("reads candles with millisecond timestamps and caps agent output to newest rows", async () => {
    mocks.client.getCandles.mockResolvedValue({
      code: 200,
      r: "1m",
      c: Array.from({ length: 105 }, (_, index) => candle(index)),
    });

    const data = await callJson("lighter.candles", {
      environment: "rhc",
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1786147200000,
      endTimestamp: 1786153500000,
      countBack: 105,
      setTimestampToEnd: true,
    });

    expect(mocks.client.getCandles).toHaveBeenCalledWith("rhc", {
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1786147200000,
      endTimestamp: 1786153500000,
      countBack: 105,
      setTimestampToEnd: true,
    });
    expect(data.count).toBe(100);
    expect(data.totalProviderRows).toBe(105);
    expect(data.truncated).toBe(true);
    expect((data.candles as Record<string, unknown>[])[0]?.index).toBe(5);
  });

  it("rejects missing or invalid params before reaching the client", async () => {
    const missingEnv = await callFail("lighter.orderbook", { marketId: 0 });
    expect(missingEnv).toContain("Missing required: environment");

    const secondsTimestamp = await callFail("lighter.candles", {
      environment: "rhc",
      marketId: 0,
      resolution: "1m",
      startTimestamp: 1786147200,
      endTimestamp: 1786150800,
    });
    expect(secondsTimestamp).toContain("epoch milliseconds");

    expect(mocks.client.getOrderBookOrders).not.toHaveBeenCalled();
    expect(mocks.client.getCandles).not.toHaveBeenCalled();
  });

  it("enforces the production runtime parameter gate before handlers run", async () => {
    const unknownParam = await executeProtocolTool({
      toolId: "lighter.markets",
      params: { environment: "rhc", unexpected: true },
    }, READ_CTX);
    expect(unknownParam.success).toBe(false);
    expect(unknownParam.output).toContain('Unknown parameter "unexpected"');
    expect(unknownParam.output).toContain("Allowed parameters: environment, marketId, filter, limit, page");

    const badEnvironment = await executeProtocolTool({
      toolId: "lighter.markets",
      params: { environment: "robinhood" },
    }, READ_CTX);
    expect(badEnvironment.success).toBe(false);
    expect(badEnvironment.output).toContain('Allowed values for "environment"');
    expect(badEnvironment.output).toContain("core, rhc");

    expect(mocks.client.getMarkets).not.toHaveBeenCalled();
  });

  it("returns a scrubbed failure when the public client rejects", async () => {
    mocks.client.getMarkets.mockRejectedValue(new Error("provider timeout after 10000ms"));

    const output = await callFail("lighter.markets", { environment: "rhc" });

    expect(output).toContain("Lighter markets unavailable");
    expect(output).toContain("provider timeout");
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      "lighter.handler.error",
      expect.objectContaining({ toolId: "lighter.markets" }),
    );
  });
});
