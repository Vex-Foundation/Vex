import { describe, expect, it, vi } from "vitest";

import { lighterTradingSnapshotSchema } from "@shared/schemas/lighter-trading.js";
import {
  readLighterTradingMarketList,
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
    getCandles: vi.fn(async () => ({
      code: 200,
      r: "1h",
      c: [
        { t: 1_787_530_000_000, o: 4_100, h: 4_250, l: 4_050, c: 4_200, v: 8, V: 33_000, i: 2 },
        { t: 1_787_526_400_000, o: 4_050, h: 4_150, l: 4_000, c: 4_100, v: 7, V: 28_000, i: 1 },
        { t: 1_787_530_000_000, o: 4_100, h: 4_260, l: 4_050, c: 4_210, v: 9, V: 37_000, i: 3 },
        { t: 1_787_533_600_000, o: 4_200, h: 4_100, l: 4_000, c: 4_050, v: 1, V: 4_000, i: 4 },
      ],
    })),
  } as unknown as LighterTradingPanelClient;
}

describe("Lighter trading panel service", () => {
  it("projects a bounded market list without provider passthrough fields", async () => {
    const result = await readLighterTradingMarketList(
      "rhc",
      fakeClient(),
      () => 1_787_530_000_000,
    );

    expect(result.markets).toEqual([
      expect.objectContaining({ marketId: 7, symbol: "ETH-USD", marketType: "perp" }),
    ]);
    expect(result.markets[0]).not.toHaveProperty("liquidation_fee");
  });

  it("sorts book and candles, deduplicates candle time, and normalizes seconds", async () => {
    const result = await readLighterTradingSnapshot(
      { environment: "core", marketId: 7, resolution: "1h" },
      fakeClient(),
      () => 1_787_530_000_000,
    );

    expect(result.book.asks.map((row) => row.price)).toEqual(["4201", "4202"]);
    expect(result.trades[0]?.timestamp).toBe(1_787_530_000_000);
    expect(result.candles).toHaveLength(2);
    expect(result.candles.map((row) => row.timestamp)).toEqual([
      1_787_526_400_000,
      1_787_530_000_000,
    ]);
    expect(result.candles[1]?.close).toBe(4_210);
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
});
