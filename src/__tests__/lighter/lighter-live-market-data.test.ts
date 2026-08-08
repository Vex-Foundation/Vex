import { describe, expect, it } from "vitest";

import {
  LIGHTER_ENVIRONMENTS,
  LIGHTER_ENDPOINT_PATHS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import { executeProtocolTool } from "@vex-agent/tools/protocols/runtime.js";
import type { ProtocolExecutionContext } from "@vex-agent/tools/protocols/types.js";

const RUN_LIVE = process.env.VEX_LIGHTER_LIVE === "1";
const describeLive = RUN_LIVE ? describe : describe.skip;

const READ_CTX: ProtocolExecutionContext = {
  sessionPermission: "restricted",
  approved: false,
  walletResolution: { source: "default" },
  walletPolicy: { kind: "none" },
};

const LIQUID_SYMBOLS = ["ETH", "ETH-USD", "BTC", "BTC-USD"] as const;
const ORDERBOOK_LIMIT = 10;
const TRADES_LIMIT = 10;
const CANDLE_COUNT_BACK = 12;

interface MarketChoice {
  readonly marketId: number;
  readonly symbol: string;
}

async function runTool(
  toolId: string,
  params: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await executeProtocolTool({ toolId, params }, READ_CTX);
  expect(result.success, result.output).toBe(true);
  expect(result.actionKind).toBe("read");
  return JSON.parse(result.output) as Record<string, unknown>;
}

function rows(value: unknown): Record<string, unknown>[] {
  expect(Array.isArray(value)).toBe(true);
  return value as Record<string, unknown>[];
}

function finiteNumber(value: unknown): number {
  expect(typeof value).toBe("number");
  expect(Number.isFinite(value)).toBe(true);
  return value as number;
}

function stringValue(value: unknown): string {
  expect(typeof value).toBe("string");
  expect((value as string).length).toBeGreaterThan(0);
  return value as string;
}

function price(row: Record<string, unknown>): number {
  const parsed = Number(row.price);
  expect(Number.isFinite(parsed)).toBe(true);
  return parsed;
}

function expectSorted(values: readonly number[], direction: "ascending" | "descending"): void {
  for (let index = 1; index < values.length; index += 1) {
    const previous = values[index - 1]!;
    const current = values[index]!;
    if (direction === "ascending") {
      expect(previous).toBeLessThanOrEqual(current);
    } else {
      expect(previous).toBeGreaterThanOrEqual(current);
    }
  }
}

function expectLiveProvenance(
  data: Record<string, unknown>,
  options: {
    readonly environment: LighterEnvironment;
    readonly toolId: string;
    readonly endpointPaths: readonly string[];
    readonly marketId?: number;
  },
): void {
  expect(data.source).toBe("live_lighter_public_api");
  const provenance = data.provenance as Record<string, unknown>;
  expect(provenance).toEqual(expect.objectContaining({
    source: "live_lighter_public_api",
    provider: "lighter",
    dataPlane: "provider_public_rest",
    toolId: options.toolId,
    environment: options.environment,
    endpointPaths: options.endpointPaths,
    cacheStatus: "fresh_or_short_cache",
    independentOnchainVerification: false,
  }));
  expect(typeof provenance.restBaseUrl).toBe("string");
  expect((provenance.restBaseUrl as string).startsWith("https://")).toBe(true);
  expect(Number.isNaN(Date.parse(stringValue(provenance.retrievedAt)))).toBe(false);
  expect(finiteNumber(provenance.maxDataAgeMs)).toBeGreaterThan(0);
  if (options.marketId !== undefined) {
    expect(provenance.marketId).toBe(options.marketId);
  }
}

function chooseMarket(markets: readonly Record<string, unknown>[]): MarketChoice {
  const active = markets.filter((market) => market.status === "active");
  expect(active.length).toBeGreaterThan(0);

  const preferred = active.find((market) =>
    LIQUID_SYMBOLS.includes(String(market.symbol).toUpperCase() as (typeof LIQUID_SYMBOLS)[number])
  );
  const selected = preferred ?? active[0]!;
  return {
    marketId: finiteNumber(selected.marketId),
    symbol: stringValue(selected.symbol),
  };
}

function candleWindow(): { readonly startTimestamp: number; readonly endTimestamp: number } {
  const endTimestamp = Math.floor((Date.now() - 60_000) / 60_000) * 60_000;
  return {
    startTimestamp: endTimestamp - CANDLE_COUNT_BACK * 60_000,
    endTimestamp,
  };
}

describeLive("Lighter live market data through protocol runtime", () => {
  for (const environment of LIGHTER_ENVIRONMENTS) {
    it(`reads ${environment} market data through executeProtocolTool`, { timeout: 60_000 }, async () => {
      const system = await runTool("lighter.system", { environment });
      expect(system.environment).toBe(environment);
      expectLiveProvenance(system, {
        environment,
        toolId: "lighter.system",
        endpointPaths: [LIGHTER_ENDPOINT_PATHS.status, LIGHTER_ENDPOINT_PATHS.systemConfig],
      });
      expect(system.status).toEqual(expect.objectContaining({
        networkId: expect.any(Number),
        timestamp: expect.any(Number),
      }));

      const marketList = await runTool("lighter.markets", {
        environment,
        filter: "all",
        limit: 50,
      });
      expect(marketList.environment).toBe(environment);
      expectLiveProvenance(marketList, {
        environment,
        toolId: "lighter.markets",
        endpointPaths: [LIGHTER_ENDPOINT_PATHS.orderBooks],
      });
      expect(marketList.truncated).toBeDefined();
      const marketRows = rows(marketList.markets);
      expect(marketRows.length).toBeGreaterThan(0);
      expect(marketRows.length).toBeLessThanOrEqual(50);

      const market = chooseMarket(marketRows);
      const detail = await runTool("lighter.market.get", {
        environment,
        marketId: market.marketId,
        filter: "all",
      });
      expect(detail.environment).toBe(environment);
      expect(detail.marketId).toBe(market.marketId);
      expectLiveProvenance(detail, {
        environment,
        toolId: "lighter.market.get",
        endpointPaths: [LIGHTER_ENDPOINT_PATHS.orderBookDetails],
        marketId: market.marketId,
      });
      expect(rows(detail.details).length).toBeGreaterThan(0);

      const book = await runTool("lighter.orderbook", {
        environment,
        marketId: market.marketId,
        limit: ORDERBOOK_LIMIT,
      });
      expect(book.environment).toBe(environment);
      expect(book.marketId).toBe(market.marketId);
      expect(book.limit).toBe(ORDERBOOK_LIMIT);
      expectLiveProvenance(book, {
        environment,
        toolId: "lighter.orderbook",
        endpointPaths: [LIGHTER_ENDPOINT_PATHS.orderBookOrders],
        marketId: market.marketId,
      });
      expect(book.sorting).toEqual({
        asks: "price_ascending",
        bids: "price_descending",
      });
      const asks = rows(book.asks);
      const bids = rows(book.bids);
      expect(asks.length).toBeLessThanOrEqual(ORDERBOOK_LIMIT);
      expect(bids.length).toBeLessThanOrEqual(ORDERBOOK_LIMIT);
      expect(finiteNumber(book.shownAsks)).toBe(asks.length);
      expect(finiteNumber(book.shownBids)).toBe(bids.length);
      expectSorted(asks.map(price), "ascending");
      expectSorted(bids.map(price), "descending");

      const trades = await runTool("lighter.recentTrades", {
        environment,
        marketId: market.marketId,
        limit: TRADES_LIMIT,
      });
      expect(trades.environment).toBe(environment);
      expect(trades.marketId).toBe(market.marketId);
      expectLiveProvenance(trades, {
        environment,
        toolId: "lighter.recentTrades",
        endpointPaths: [LIGHTER_ENDPOINT_PATHS.recentTrades],
        marketId: market.marketId,
      });
      const tradeRows = rows(trades.trades);
      expect(tradeRows.length).toBeLessThanOrEqual(TRADES_LIMIT);
      expect(finiteNumber(trades.count)).toBe(tradeRows.length);

      const window = candleWindow();
      const candles = await runTool("lighter.candles", {
        environment,
        marketId: market.marketId,
        resolution: "1m",
        startTimestamp: window.startTimestamp,
        endTimestamp: window.endTimestamp,
        countBack: CANDLE_COUNT_BACK,
      });
      expect(candles.environment).toBe(environment);
      expect(candles.marketId).toBe(market.marketId);
      expect(candles.resolution).toBe("1m");
      expectLiveProvenance(candles, {
        environment,
        toolId: "lighter.candles",
        endpointPaths: [LIGHTER_ENDPOINT_PATHS.candles],
        marketId: market.marketId,
      });
      const candleRows = rows(candles.candles);
      expect(candleRows.length).toBeLessThanOrEqual(100);
      expect(finiteNumber(candles.count)).toBe(candleRows.length);
      expect(finiteNumber(candles.totalProviderRows)).toBeGreaterThanOrEqual(candleRows.length);

      process.stdout.write(
        `${JSON.stringify({
          event: "lighter.live.market_data",
          environment,
          networkId: (system.status as { networkId: number }).networkId,
          marketId: market.marketId,
          symbol: market.symbol,
          shownAsks: asks.length,
          shownBids: bids.length,
          trades: tradeRows.length,
          candles: candleRows.length,
        })}\n`,
      );
    });
  }
});
