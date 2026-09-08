import { describe, expect, it } from "vitest";
import { getLighterClient } from "@tools/lighter/client.js";
import type { LighterMarketDetailsResponse } from "@tools/lighter/types.js";
import { lighterTradingMarketListSchema } from "@shared/schemas/lighter-trading.js";
import { readLighterTradingMarketList, type LighterTradingPanelClient } from "../trading-panel-service.js";

const describeLive = process.env["VEX_LIGHTER_PANEL_LIVE"] === "1" ? describe : describe.skip;

describeLive("Lighter market picker live read-only statistics", () => {
  for (const environment of ["core", "rhc"] as const) {
    it(`projects real ${environment} bulk detail values without per-market reads`, { timeout: 60_000 }, async () => {
      const client = getLighterClient();
      let captured: LighterMarketDetailsResponse | undefined;
      let detailReads = 0;
      const readClient: LighterTradingPanelClient = {
        getMarkets: (...args) => client.getMarkets(...args),
        getMarketDetails: async (...args) => {
          detailReads += 1;
          captured = await client.getMarketDetails(...args);
          return captured;
        },
        getOrderBookOrders: (...args) => client.getOrderBookOrders(...args),
        getRecentTrades: (...args) => client.getRecentTrades(...args),
        getCandles: (...args) => client.getCandles(...args),
      };
      const list = await readLighterTradingMarketList(environment, readClient);
      expect(lighterTradingMarketListSchema.safeParse(list).success).toBe(true);
      expect(detailReads).toBe(1);
      expect(captured).toBeDefined();
      const details = [...(captured?.order_book_details ?? []), ...(captured?.spot_order_book_details ?? [])];
      let prices = 0;
      let interests = 0;
      for (const market of list.markets) {
        const detail = details.find((row) => row.market_id === market.marketId && row.market_type === market.marketType
          && row.symbol === market.symbol && row.base_asset_id === market.baseAssetId && row.quote_asset_id === market.quoteAssetId);
        const statistics = market.statistics;
        expect(statistics?.lastTradePrice).toBe(nonnegative(detail?.last_trade_price));
        expect(statistics?.priceChange24h).toBe(finite(detail?.daily_price_change));
        expect(statistics?.openInterestBase).toBe(market.marketType === "perp" ? nonnegative(detail?.open_interest) : null);
        expect(market.activity24h.quoteVolume).toBe(nonnegative(detail?.daily_quote_token_volume));
        if (statistics?.lastTradePrice !== null && statistics?.lastTradePrice !== undefined) prices += 1;
        if (statistics?.openInterestBase !== null && statistics?.openInterestBase !== undefined) interests += 1;
      }
      expect(prices).toBeGreaterThan(0);
      expect(interests).toBeGreaterThan(0);
      process.stdout.write(`${JSON.stringify({ event: "lighter.market_list.live_statistics", environment,
        retrievedAt: list.retrievedAt, markets: list.markets.length, prices, interests, detailReads })}\n`);
    });
  }
});

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function nonnegative(value: unknown): number | null {
  const parsed = finite(value);
  return parsed !== null && parsed >= 0 ? parsed : null;
}
