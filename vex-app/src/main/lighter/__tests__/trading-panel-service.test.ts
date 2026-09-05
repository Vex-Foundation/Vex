import { describe, expect, it, vi } from "vitest";

import { lighterTradingSnapshotSchema } from "@shared/schemas/lighter-trading.js";
import {
  projectLighterTradingMarket,
  readLighterTradingMarketList,
  readLighterTradingMarketSnapshot,
  readLighterTradingSnapshot,
  type LighterTradingPanelClient,
} from "../trading-panel-service.js";

const market = {
  symbol: "ETH-USD",
  market_id: 7,
  market_type: "perp",
  base_asset_id: 1,
  quote_asset_id: 2,
  status: "active",
  taker_fee: "0",
  maker_fee: "0",
  liquidation_fee: "0.01",
  min_base_amount: "0.001",
  min_quote_amount: "10",
  supported_size_decimals: 4,
  supported_price_decimals: 2,
  supported_quote_decimals: 6,
  order_quote_limit: "1000000",
  is_maker_fee_enabled: false,
  is_taker_fee_enabled: false,
} as const;

function fakeClient(): LighterTradingPanelClient {
  return {
    getMarkets: vi.fn(async () => ({ code: 200, order_books: [market] })),
    getMarketDetails: vi.fn(async () => ({
      code: 200,
      order_book_details: [
        {
          ...market,
          last_trade_price: 4_200,
          open_interest: 12_300,
          daily_trades_count: 120,
          daily_base_token_volume: 30,
          daily_quote_token_volume: 126_000,
          daily_price_low: 4_000,
          daily_price_high: 4_300,
          daily_price_change: 1.2,
          funding_clamp_small: "-0.0001",
          funding_clamp_big: "0.0001",
          base_interest_rate: "0.00001",
        },
      ],
      spot_order_book_details: [],
    })),
    getOrderBookOrders: vi.fn(async () => ({
      code: 200,
      total_asks: 2,
      total_bids: 1,
      asks: [
        {
          order_index: 2,
          order_id: "90071992547409931235",
          owner_account_index: 2,
          initial_base_amount: "2",
          remaining_base_amount: "2",
          price: "4202",
          order_expiry: 0,
          transaction_time: 1,
        },
        {
          order_index: 1,
          order_id: "90071992547409931234",
          owner_account_index: 1,
          initial_base_amount: "1",
          remaining_base_amount: "1",
          price: "4201",
          order_expiry: 0,
          transaction_time: 1,
        },
      ],
      bids: [
        {
          order_index: 3,
          order_id: "90071992547409931233",
          owner_account_index: 3,
          initial_base_amount: "1",
          remaining_base_amount: "1",
          price: "4199",
          order_expiry: 0,
          transaction_time: 1,
        },
      ],
    })),
    getRecentTrades: vi.fn(async () => ({
      code: 200,
      trades: [
        {
          trade_id: 1,
          trade_id_str: "90071992547409939999",
          tx_hash: "0x1",
          type: "trade",
          market_id: 7,
          size: "0.1",
          price: "4200",
          usd_amount: "420",
          ask_id: 1,
          ask_id_str: "1",
          bid_id: 2,
          bid_id_str: "2",
          ask_account_id: 3,
          bid_account_id: 4,
          is_maker_ask: true,
          block_height: 5,
          timestamp: 1_787_530_000,
        },
      ],
    })),
    getCandles: vi.fn(async (_environment, params) => ({
      code: 200,
      r: params.resolution,
      c: [
        { t: 1_787_530_000_000, o: 4_100, h: 4_250, l: 4_050, c: 4_200, v: 8, V: 33_000, i: "2" },
        { t: 1_787_526_400_000, o: 4_050, h: 4_150, l: 4_000, c: 4_100, v: 7, V: 28_000, i: "1" },
        { t: 1_787_530_000_000, o: 4_100, h: 4_260, l: 4_050, c: 4_210, v: 9, V: 37_000, i: "3" },
        { t: 1_787_533_600_000, o: 4_200, h: 4_100, l: 4_000, c: 4_050, v: 1, V: 4_000, i: "4" },
      ],
    })),
  } as unknown as LighterTradingPanelClient;
}

describe("Lighter trading panel service", () => {
  it("keeps price changes signed, rejects invalid metrics, and never assigns open interest to spot", () => {
    const projected = projectLighterTradingMarket(market, {
      ...market, last_trade_price: -1, daily_price_change: -5,
      open_interest: Number.POSITIVE_INFINITY,
    });
    expect(projected.statistics).toEqual({ lastTradePrice: null, priceChange24h: -5, openInterestBase: null });
    const spot = { ...market, market_type: "spot" as const };
    expect(projectLighterTradingMarket(spot, { ...spot, open_interest: 123 }).statistics?.openInterestBase).toBeNull();
    expect(projectLighterTradingMarket(market, { ...market, daily_price_change: Number.NaN }).statistics?.priceChange24h).toBeNull();
  });

  it("projects a bounded market list without provider passthrough fields", async () => {
    const client = fakeClient();
    const result = await readLighterTradingMarketList(
      "rhc",
      client,
      () => 1_787_530_000_000,
    );

    expect(result.markets).toEqual([
      expect.objectContaining({
        marketId: 7,
        symbol: "ETH-USD",
        marketType: "perp",
        activity24h: { tradesCount: 120, quoteVolume: 126_000 },
        statistics: { lastTradePrice: 4_200, priceChange24h: 1.2, openInterestBase: 12_300 },
      }),
    ]);
    expect(result.markets[0]).not.toHaveProperty("liquidation_fee");
    expect(client.getMarketDetails).toHaveBeenCalledWith("rhc", {
      marketId: 255,
      filter: "all",
    });
  });

  it("does not attach activity from mismatched provider identity", async () => {
    const client = fakeClient();
    vi.mocked(client.getMarketDetails).mockResolvedValueOnce({
      code: 200,
      order_book_details: [{
        ...market,
        symbol: "WRONG",
        daily_trades_count: 500,
        daily_quote_token_volume: 1_000_000,
      }],
      spot_order_book_details: [],
    });

    const result = await readLighterTradingMarketList("rhc", client);

    expect(result.markets[0]?.activity24h).toEqual({
      tradesCount: null,
      quoteVolume: null,
    });
    expect(result.markets[0]?.statistics).toEqual({
      lastTradePrice: null, priceChange24h: null, openInterestBase: null,
    });
  });

  it("keeps the market list available when provider activity details are unavailable", async () => {
    const client = fakeClient();
    vi.mocked(client.getMarketDetails).mockRejectedValueOnce(new Error("details unavailable"));

    const result = await readLighterTradingMarketList("rhc", client);

    expect(result.markets[0]?.activity24h).toEqual({
      tradesCount: null,
      quoteVolume: null,
    });
  });

  it("sorts book and candles, deduplicates candle time, and normalizes seconds", async () => {
    const client = fakeClient();
    const result = await readLighterTradingSnapshot(
      { environment: "core", marketId: 7, resolution: "1h" },
      client,
      () => 1_787_530_000_000,
    );

    expect(result.book.asks.map((row) => row.price)).toEqual(["4201", "4202"]);
    expect(result.trades[0]?.timestamp).toBe(1_787_530_000_000);
    expect(result.candles).toHaveLength(2);
    expect(result.candles.map((row) => row.timestamp)).toEqual([
      1_787_526_400_000,
      1_787_530_000_000,
    ]);
    expect(result.candles[1]).toMatchObject({
      close: 4_210,
      lastTradeId: "3",
      providerResolution: "1h",
      source: "rest_snapshot",
    });
    expect(client.getCandles).toHaveBeenCalledWith("core", expect.objectContaining({
      marketId: 7,
      resolution: "1h",
      setTimestampToEnd: false,
    }));
    expect(lighterTradingSnapshotSchema.safeParse(result).success).toBe(true);
  });

  it("hydrates spot detail from the provider spot collection", async () => {
    const spotMarket = {
      ...market,
      symbol: "ETH/USDC",
      market_id: 8,
      market_type: "spot" as const,
    };
    const base = fakeClient();
    const client: LighterTradingPanelClient = {
      ...base,
      getMarkets: vi.fn(async () => ({ code: 200, order_books: [spotMarket] })),
      getMarketDetails: vi.fn(async () => ({
        code: 200,
        order_book_details: [],
        spot_order_book_details: [
          {
            ...spotMarket,
            last_trade_price: 4_200,
            daily_trades_count: 12,
          },
        ],
      })),
      getRecentTrades: vi.fn(async (environment, params) => {
        const response = await base.getRecentTrades(environment, params);
        return {
          ...response,
          trades: response.trades.map((trade) => ({ ...trade, market_id: 8 })),
        };
      }),
    };

    const result = await readLighterTradingSnapshot(
      { environment: "rhc", marketId: 8, resolution: "15m" },
      client,
      () => 1_787_530_000_000,
    );

    expect(result.market).toMatchObject({
      marketId: 8,
      symbol: "ETH/USDC",
      marketType: "spot",
    });
    expect(result.detail).toMatchObject({ lastTradePrice: 4_200 });
    expect(lighterTradingSnapshotSchema.safeParse(result).success).toBe(true);
  });

  it("rejects unsupported weekly candles before calling the provider", async () => {
    const client = fakeClient();

    await expect(readLighterTradingSnapshot(
      { environment: "core", marketId: 7, resolution: "1w" },
      client,
      () => 1_787_530_000_000,
    )).rejects.toThrow("does not support 1w");

    expect(client.getCandles).not.toHaveBeenCalled();
    expect(client.getOrderBookOrders).not.toHaveBeenCalled();
  });

  it("starts candle history independently of order-book availability", async () => {
    const client = fakeClient();
    vi.mocked(client.getOrderBookOrders).mockRejectedValueOnce(new Error("book unavailable"));

    await expect(readLighterTradingSnapshot(
      { environment: "rhc", marketId: 7, resolution: "15m" },
      client,
      () => 1_787_530_000_000,
    )).rejects.toThrow("book unavailable");

    expect(client.getCandles).toHaveBeenCalledOnce();
    expect(client.getCandles).toHaveBeenCalledWith("rhc", expect.objectContaining({
      resolution: "15m",
      setTimestampToEnd: false,
    }));
  });

  it("hydrates the IPC market snapshot without a duplicate candle-history gate", async () => {
    const client = fakeClient();
    const result = await readLighterTradingMarketSnapshot(
      { environment: "core", marketId: 7, resolution: "5m" },
      client,
      () => 1_787_530_000_000,
    );

    expect(result.book.asks).toHaveLength(2);
    expect(result.trades).toHaveLength(1);
    expect(result.candles).toEqual([]);
    expect(client.getCandles).not.toHaveBeenCalled();
    expect(lighterTradingSnapshotSchema.safeParse(result).success).toBe(true);
  });

  it("rejects a same-id detail from the wrong product collection", async () => {
    const client = fakeClient();
    vi.mocked(client.getMarketDetails).mockResolvedValueOnce({
      code: 200,
      order_book_details: [],
      spot_order_book_details: [{ ...market, market_type: "spot" }],
    });

    await expect(readLighterTradingMarketSnapshot(
      { environment: "core", marketId: 7, resolution: "5m" },
      client,
    )).rejects.toThrow("detail is unavailable");
  });

  it("rejects recent trades scoped to another market", async () => {
    const client = fakeClient();
    const response = await client.getRecentTrades("core", { marketId: 7, limit: 40 });
    vi.mocked(client.getRecentTrades).mockResolvedValueOnce({
      ...response,
      trades: response.trades.map((trade) => ({ ...trade, market_id: 8 })),
    });

    await expect(readLighterTradingMarketSnapshot(
      { environment: "core", marketId: 7, resolution: "5m" },
      client,
    )).rejects.toThrow("trades do not match");
  });
});
