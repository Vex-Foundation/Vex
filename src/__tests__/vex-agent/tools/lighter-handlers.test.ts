import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";
import type {
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

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

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
    tx_hash: `0x${id}`,
    type: "trade",
    market_id: 0,
    size: "0.25",
    price: "3500",
    usd_amount: "875",
    ask_id: 10,
    bid_id: 11,
    ask_account_id: 12,
    bid_account_id: 13,
    is_maker_ask: true,
    block_height: 99,
    timestamp: 1786147200000 + id,
    transaction_time: 1786147200000 + id,
    trade_id_str: `trade-${id}`,
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

  it("lists markets with an explicit environment and bounded output", async () => {
    mocks.client.getMarkets.mockResolvedValue({
      code: 200,
      order_books: [
        MARKET,
        { ...MARKET, market_id: 1, symbol: "BTC-USD" },
        { ...MARKET, market_id: 2, symbol: "SOL-USD" },
      ],
    });

    const data = await callJson("lighter.markets", {
      environment: "core",
      filter: "perp",
      limit: 2,
    });

    expect(mocks.client.getMarkets).toHaveBeenCalledWith("core", { filter: "perp" });
    expect(data.count).toBe(2);
    expect(data.totalProviderRows).toBe(3);
    expect(data.truncated).toBe(true);
    expect((data.markets as Record<string, unknown>[])[0]?.symbol).toBe("ETH-USD");
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

  it("reads order book orders with side totals and truncation flags", async () => {
    mocks.client.getOrderBookOrders.mockResolvedValue({
      code: 200,
      total_asks: 3,
      asks: [order(1, "3501"), order(2, "3502"), order(3, "3503")],
      total_bids: 2,
      bids: [order(4, "3499"), order(5, "3498")],
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
    expect(data.bidsTruncated).toBe(false);
    expect((data.asks as Record<string, unknown>[])[0]?.price).toBe("3501");
  });

  it("reads recent trades with bounded rows and next cursor disclosure", async () => {
    mocks.client.getRecentTrades.mockResolvedValue({
      code: 200,
      next_cursor: "cursor-1",
      trades: [trade(1), trade(2), trade(3)],
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
