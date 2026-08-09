import {
  LIGHTER_CACHE_TTL_MS,
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import { getLighterClient } from "@tools/lighter/client.js";
import { VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import { describeFailureForAgent, describeFailureForLog } from "../../runtime/errors.js";
import {
  LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
  readCountBack,
  readEnvironment,
  readMarketFilter,
  readMarketId,
  readMarketListLimit,
  readMarketListPage,
  readOrderBookLimit,
  readRecentTradesLimit,
  readResolution,
  readSetTimestampToEnd,
  readTimestamp,
} from "../params.js";
import {
  projectCandles,
  projectMarket,
  projectMarketDetails,
  projectOrderBook,
  projectRecentTrades,
  projectSystem,
  sortMarketsForDisplay,
  takePage,
} from "../projectors.js";

function failureDetail(toolId: string, err: unknown): string {
  logger.warn("lighter.handler.error", {
    toolId,
    code: err instanceof VexError ? err.code : "UNEXPECTED",
    error: describeFailureForLog(err),
  });
  return describeFailureForAgent(err);
}

function liveProvenance(
  environment: LighterEnvironment,
  toolId: string,
  endpointPaths: readonly string[],
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "live_lighter_public_api",
    provenance: {
      source: "live_lighter_public_api",
      provider: "lighter",
      dataPlane: "provider_public_rest",
      toolId,
      environment,
      restBaseUrl: LIGHTER_ENDPOINTS[environment].restBaseUrl,
      endpointPaths,
      retrievedAt: new Date().toISOString(),
      cacheStatus: "fresh_or_short_cache",
      maxDataAgeMs: LIGHTER_CACHE_TTL_MS,
      independentOnchainVerification: false,
      ...details,
    },
  };
}

export const LIGHTER_READ_HANDLERS: Record<string, ProtocolHandler> = {
  "lighter.system": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);

    try {
      const client = getLighterClient();
      const [status, systemConfig] = await Promise.all([
        client.getStatus(environment.value),
        client.getSystemConfig(environment.value),
      ]);
      return ok({
        ...liveProvenance(environment.value, "lighter.system", [
          LIGHTER_ENDPOINT_PATHS.status,
          LIGHTER_ENDPOINT_PATHS.systemConfig,
        ]),
        environment: environment.value,
        ...projectSystem(status, systemConfig),
      });
    } catch (err) {
      return fail(`Lighter system read unavailable (${failureDetail("lighter.system", err)})`);
    }
  },

  "lighter.markets": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, false);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);
    const limit = readMarketListLimit(params);
    if (!limit.ok) return fail(limit.reason);
    const page = readMarketListPage(params);
    if (!page.ok) return fail(page.reason);

    try {
      const response = await getLighterClient().getMarkets(environment.value, {
        ...(marketId.value === undefined ? {} : { marketId: marketId.value }),
        ...(filter.value === undefined ? {} : { filter: filter.value }),
      });
      const projected = sortMarketsForDisplay(response.order_books).map(projectMarket);
      const window = takePage(projected, page.value, limit.value);
      if (window.total > 0 && page.value > window.lastPage) {
        return fail(
          `Lighter markets page ${page.value} is past the last page (${window.lastPage}) for ${window.total} matching markets. Request page ${window.lastPage} or lower.`,
        );
      }
      return ok({
        ...liveProvenance(environment.value, "lighter.markets", [
          LIGHTER_ENDPOINT_PATHS.orderBooks,
        ], {
          marketId: marketId.value ?? null,
          filter: filter.value ?? null,
          outputLimit: limit.value,
          page: page.value,
          lastPage: window.lastPage,
          sortOrder: "active_first_market_id_ascending",
        }),
        environment: environment.value,
        marketId: marketId.value ?? null,
        filter: filter.value ?? null,
        page: page.value,
        lastPage: window.lastPage,
        nextPage: window.hasMore ? page.value + 1 : null,
        sorting: {
          markets: "active_first_market_id_ascending",
        },
        count: window.count,
        totalProviderRows: window.total,
        truncated: window.truncated,
        truncationNote: window.truncated
          ? `Showing page ${page.value} (${window.count} rows) from ${window.total} markets after active-first, market-id ascending ordering.${window.hasMore ? ` Request page ${page.value + 1} to continue.` : " No later page remains."}`
          : null,
        markets: window.rows,
      });
    } catch (err) {
      return fail(`Lighter markets unavailable (${failureDetail("lighter.markets", err)})`);
    }
  },

  "lighter.market.get": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);

    try {
      const response = await getLighterClient().getMarketDetails(environment.value, {
        marketId: marketId.value!,
        ...(filter.value === undefined ? {} : { filter: filter.value }),
      });
      const details = projectMarketDetails(response);
      const exact = details.filter((detail) => detail.marketId === marketId.value);
      if (exact.length === 0) {
        return fail(`No Lighter market detail found for marketId ${marketId.value} on ${environment.value}.`);
      }
      return ok({
        ...liveProvenance(environment.value, "lighter.market.get", [
          LIGHTER_ENDPOINT_PATHS.orderBookDetails,
        ], {
          marketId: marketId.value,
          filter: filter.value ?? null,
        }),
        environment: environment.value,
        marketId: marketId.value,
        filter: filter.value ?? null,
        count: exact.length,
        details: exact,
      });
    } catch (err) {
      return fail(`Lighter market detail unavailable (${failureDetail("lighter.market.get", err)})`);
    }
  },

  "lighter.orderbook": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const limit = readOrderBookLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getOrderBookOrders(environment.value, {
        marketId: marketId.value!,
        limit: limit.value,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.orderbook", [
          LIGHTER_ENDPOINT_PATHS.orderBookOrders,
        ], {
          marketId: marketId.value,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        marketId: marketId.value,
        limit: limit.value,
        ...projectOrderBook(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter order book unavailable (${failureDetail("lighter.orderbook", err)})`);
    }
  },

  "lighter.recentTrades": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const limit = readRecentTradesLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getRecentTrades(environment.value, {
        marketId: marketId.value!,
        limit: limit.value,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.recentTrades", [
          LIGHTER_ENDPOINT_PATHS.recentTrades,
        ], {
          marketId: marketId.value,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        marketId: marketId.value,
        limit: limit.value,
        ...projectRecentTrades(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter recent trades unavailable (${failureDetail("lighter.recentTrades", err)})`);
    }
  },

  "lighter.candles": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const marketId = readMarketId(params, true);
    if (!marketId.ok) return fail(marketId.reason);
    const resolution = readResolution(params);
    if (!resolution.ok) return fail(resolution.reason);
    const startTimestamp = readTimestamp(params, "startTimestamp");
    if (!startTimestamp.ok) return fail(startTimestamp.reason);
    const endTimestamp = readTimestamp(params, "endTimestamp");
    if (!endTimestamp.ok) return fail(endTimestamp.reason);
    if (endTimestamp.value <= startTimestamp.value) {
      return fail("endTimestamp must be greater than startTimestamp.");
    }
    const countBack = readCountBack(params);
    if (!countBack.ok) return fail(countBack.reason);
    const setTimestampToEnd = readSetTimestampToEnd(params);

    try {
      const response = await getLighterClient().getCandles(environment.value, {
        marketId: marketId.value!,
        resolution: resolution.value,
        startTimestamp: startTimestamp.value,
        endTimestamp: endTimestamp.value,
        ...(countBack.value === undefined ? {} : { countBack: countBack.value }),
        ...(setTimestampToEnd === undefined ? {} : { setTimestampToEnd }),
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.candles", [
          LIGHTER_ENDPOINT_PATHS.candles,
        ], {
          marketId: marketId.value,
          resolution: resolution.value,
          startTimestamp: startTimestamp.value,
          endTimestamp: endTimestamp.value,
          countBack: countBack.value ?? null,
        }),
        environment: environment.value,
        marketId: marketId.value,
        requestedWindow: {
          startTimestamp: startTimestamp.value,
          endTimestamp: endTimestamp.value,
        },
        countBack: countBack.value ?? null,
        outputLimit: LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
        ...projectCandles(response, LIGHTER_AGENT_CANDLE_OUTPUT_MAX),
      });
    } catch (err) {
      return fail(`Lighter candles unavailable (${failureDetail("lighter.candles", err)})`);
    }
  },
};
