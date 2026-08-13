import {
  LIGHTER_API_KEY_INDEX_ALL,
  LIGHTER_CACHE_TTL_MS,
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENDPOINTS,
  type LighterEnvironment,
} from "@tools/lighter/constants.js";
import { getLighterClient, type LighterClient } from "@tools/lighter/client.js";
import { getLighterReadOnlyCredentialStatus } from "@tools/lighter/credentials.js";
import { buildLighterOrderPreview } from "@tools/lighter/order-preview.js";
import {
  LIGHTER_TRADING_API_KEY_INDEX_MAX,
  LIGHTER_TRADING_API_KEY_INDEX_MIN,
} from "@tools/lighter/trading-credentials.js";
import type { LighterMarket, LighterMarketDetail } from "@tools/lighter/types.js";
import { ErrorCodes, VexError } from "../../../../../errors.js";
import logger from "@utils/logger.js";
import type { ProtocolHandler } from "../../types.js";
import { fail, ok } from "../../handler-helpers.js";
import * as lighterOrderPreviewsRepo from "@vex-agent/db/repos/lighter-order-previews.js";
import { describeFailureForAgent, describeFailureForLog } from "../../runtime/errors.js";
import {
  LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
  LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
  LIGHTER_AGENT_ACCOUNT_ROW_MAX,
  readAccountOrderLimit,
  readApiKeyIndex,
  readApiKeyLimit,
  readAccountLookup,
  readCountBack,
  readEnvironment,
  readLighterOrderPreviewParams,
  readMarketFilter,
  readMarketId,
  readMarketListLimit,
  readMarketListPage,
  readOptionalAccountIndex,
  readRequiredAccountIndex,
  readOrderBookLimit,
  readRecentTradesLimit,
  readResolution,
  readSetTimestampToEnd,
  readTimestamp,
} from "../params.js";
import {
  projectCandles,
  projectAccountResponse,
  projectApiKeys,
  projectAccountOrders,
  projectMarket,
  projectMarketDetails,
  projectOrderBook,
  projectPositions,
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

function readOnlyAccountProvenance(
  environment: LighterEnvironment,
  toolId: string,
  endpointPaths: readonly string[],
  details: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    source: "live_lighter_read_only_account_api",
    provenance: {
      source: "live_lighter_read_only_account_api",
      provider: "lighter",
      dataPlane: "provider_read_only_auth_rest",
      toolId,
      environment,
      restBaseUrl: LIGHTER_ENDPOINTS[environment].restBaseUrl,
      endpointPaths,
      retrievedAt: new Date().toISOString(),
      cacheStatus: "fresh_no_cache",
      maxDataAgeMs: 0,
      authenticated: true,
      credentialCapability: "read_only_account_data",
      independentOnchainVerification: false,
      ...details,
    },
  };
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

function findMarketDetail(
  response: {
    readonly order_book_details: readonly LighterMarketDetail[];
    readonly spot_order_book_details: readonly LighterMarketDetail[];
  },
  marketId: number,
): LighterMarketDetail | null {
  return [
    ...response.order_book_details,
    ...response.spot_order_book_details,
  ].find((detail) => detail.market_id === marketId) ?? null;
}

function normalizeMarketSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/^\$/, "");
}

function marketSymbolScore(market: LighterMarket, wanted: string): number {
  const symbol = normalizeMarketSymbol(market.symbol);
  if (symbol === wanted) return 0;
  if (symbol === `${wanted}-USD`) return 1;
  if (symbol === `${wanted}/USD`) return 2;
  if (symbol.split(/[-/]/)[0] === wanted) return 3;
  return Number.POSITIVE_INFINITY;
}

async function resolvePreviewMarketId(
  client: LighterClient,
  environment: LighterEnvironment,
  params: { readonly marketId?: number; readonly marketSymbol?: string },
): Promise<number> {
  if (params.marketId !== undefined) return params.marketId;
  if (params.marketSymbol === undefined) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Lighter order preview needs a market symbol or market id.",
      "Say the asset symbol, for example ETH.",
    );
  }

  const wanted = normalizeMarketSymbol(params.marketSymbol);
  const markets = await client.getMarkets(environment, { filter: "all" });
  const selected = markets.order_books
    .map((market) => ({ market, score: marketSymbolScore(market, wanted) }))
    .filter((candidate) => Number.isFinite(candidate.score))
    .sort((left, right) => {
      const activeDiff =
        (left.market.status === "active" ? 0 : 1) - (right.market.status === "active" ? 0 : 1);
      if (activeDiff !== 0) return activeDiff;
      if (left.score !== right.score) return left.score - right.score;
      return left.market.market_id - right.market.market_id;
    })[0]?.market;
  if (!selected) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `No live Lighter ${environment} market found for ${wanted}.`,
      "Use a listed Lighter market symbol, for example ETH.",
    );
  }
  return selected.market_id;
}

function resolvePreviewAccountIndex(
  environment: LighterEnvironment,
  requestedAccountIndex?: number,
): number {
  if (requestedAccountIndex !== undefined) return requestedAccountIndex;
  const status = getLighterReadOnlyCredentialStatus(environment);
  if (!status.configured || !status.metadata || status.metadata.expired) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `No active Lighter ${environment} read-only account credential is configured.`,
      "Open Settings > API keys and save a Lighter read-only token for this environment, then ask again without an account id.",
    );
  }
  return status.metadata.accountIndex;
}

async function resolvePreviewApiKeyIndex(
  client: LighterClient,
  environment: LighterEnvironment,
  accountIndex: number,
  requestedApiKeyIndex: number | null | undefined,
): Promise<{
  readonly apiKeyIndex: number | null;
  readonly apiKeyLookupStatus: "caller_supplied" | "resolved" | "not_found" | "unavailable";
}> {
  if (requestedApiKeyIndex !== null && requestedApiKeyIndex !== undefined) {
    return {
      apiKeyIndex: requestedApiKeyIndex,
      apiKeyLookupStatus: "caller_supplied",
    };
  }
  try {
    const response = await client.getApiKeys(environment, {
      accountIndex,
      apiKeyIndex: LIGHTER_API_KEY_INDEX_ALL,
    });
    const selected = response.api_keys
      .filter((key) =>
        key.api_key_index >= LIGHTER_TRADING_API_KEY_INDEX_MIN
        && key.api_key_index <= LIGHTER_TRADING_API_KEY_INDEX_MAX)
      .sort((left, right) => left.api_key_index - right.api_key_index)[0];
    return {
      apiKeyIndex: selected?.api_key_index ?? null,
      apiKeyLookupStatus: selected ? "resolved" : "not_found",
    };
  } catch (err) {
    logger.warn("lighter.order.preview.api_key_lookup_unavailable", {
      environment,
      accountIndex,
      error: describeFailureForLog(err),
    });
    return {
      apiKeyIndex: null,
      apiKeyLookupStatus: "unavailable",
    };
  }
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

  "lighter.account.get": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const lookup = readAccountLookup(params);
    if (!lookup.ok) return fail(lookup.reason);

    try {
      const response = await getLighterClient().getAccount(environment.value, {
        by: lookup.value.by,
        value: lookup.value.value,
        activeOnly: lookup.value.activeOnly,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.account.get", [
          LIGHTER_ENDPOINT_PATHS.account,
        ], {
          accountIndex: lookup.value.accountIndex,
          l1Address: lookup.value.l1Address,
          accountLookupSource: lookup.value.by,
          authenticated: false,
          outputAccountLimit: LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          outputPositionLimit: LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        }),
        environment: environment.value,
        accountIndex: lookup.value.accountIndex,
        l1Address: lookup.value.l1Address,
        activeOnly: lookup.value.activeOnly ?? null,
        ...projectAccountResponse(
          response,
          LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        ),
      });
    } catch (err) {
      return fail(`Lighter account read unavailable (${failureDetail("lighter.account.get", err)})`);
    }
  },

  "lighter.positions": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const lookup = readAccountLookup(params);
    if (!lookup.ok) return fail(lookup.reason);

    try {
      const response = await getLighterClient().getAccount(environment.value, {
        by: lookup.value.by,
        value: lookup.value.value,
        activeOnly: lookup.value.activeOnly,
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.positions", [
          LIGHTER_ENDPOINT_PATHS.account,
        ], {
          accountIndex: lookup.value.accountIndex,
          l1Address: lookup.value.l1Address,
          accountLookupSource: lookup.value.by,
          authenticated: false,
          outputAccountLimit: LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          outputPositionLimit: LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        }),
        environment: environment.value,
        accountIndex: lookup.value.accountIndex,
        l1Address: lookup.value.l1Address,
        activeOnly: lookup.value.activeOnly ?? null,
        ...projectPositions(
          response,
          LIGHTER_AGENT_ACCOUNT_ROW_MAX,
          LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
        ),
      });
    } catch (err) {
      return fail(`Lighter positions read unavailable (${failureDetail("lighter.positions", err)})`);
    }
  },

  "lighter.openOrders": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readOptionalAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const marketId = readMarketId(params, false);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);
    const limit = readAccountOrderLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getAccountActiveOrders(environment.value, {
        ...(accountIndex.value === undefined ? {} : { accountIndex: accountIndex.value }),
        ...(marketId.value === undefined ? {} : { marketId: marketId.value }),
        ...(filter.value === undefined ? {} : { marketType: filter.value }),
      });
      return ok({
        ...readOnlyAccountProvenance(environment.value, "lighter.openOrders", [
          LIGHTER_ENDPOINT_PATHS.accountActiveOrders,
        ], {
          accountIndex: accountIndex.value ?? null,
          accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
          marketId: marketId.value ?? null,
          filter: filter.value ?? null,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: accountIndex.value ?? null,
        accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
        marketId: marketId.value ?? null,
        filter: filter.value ?? null,
        limit: limit.value,
        ...projectAccountOrders(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter open orders unavailable (${failureDetail("lighter.openOrders", err)})`);
    }
  },

  "lighter.orderHistory": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readOptionalAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const marketId = readMarketId(params, false);
    if (!marketId.ok) return fail(marketId.reason);
    const filter = readMarketFilter(params);
    if (!filter.ok) return fail(filter.reason);
    const limit = readAccountOrderLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getAccountInactiveOrders(environment.value, {
        ...(accountIndex.value === undefined ? {} : { accountIndex: accountIndex.value }),
        ...(marketId.value === undefined ? {} : { marketId: marketId.value }),
        ...(filter.value === undefined ? {} : { marketType: filter.value }),
        limit: limit.value,
      });
      return ok({
        ...readOnlyAccountProvenance(environment.value, "lighter.orderHistory", [
          LIGHTER_ENDPOINT_PATHS.accountInactiveOrders,
        ], {
          accountIndex: accountIndex.value ?? null,
          accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
          marketId: marketId.value ?? null,
          filter: filter.value ?? null,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: accountIndex.value ?? null,
        accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
        marketId: marketId.value ?? null,
        filter: filter.value ?? null,
        limit: limit.value,
        ...projectAccountOrders(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter order history unavailable (${failureDetail("lighter.orderHistory", err)})`);
    }
  },

  "lighter.trades": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readOptionalAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const limit = readAccountOrderLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getAccountTrades(environment.value, {
        ...(accountIndex.value === undefined ? {} : { accountIndex: accountIndex.value }),
        limit: limit.value,
        sortBy: "timestamp",
      });
      return ok({
        ...readOnlyAccountProvenance(environment.value, "lighter.trades", [
          LIGHTER_ENDPOINT_PATHS.trades,
        ], {
          accountIndex: accountIndex.value ?? null,
          accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: accountIndex.value ?? null,
        accountIndexSource: accountIndex.value === undefined ? "credential" : "caller",
        limit: limit.value,
        ...projectRecentTrades(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter account trades unavailable (${failureDetail("lighter.trades", err)})`);
    }
  },

  "lighter.apiKeys.inspect": async (params) => {
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const accountIndex = readRequiredAccountIndex(params);
    if (!accountIndex.ok) return fail(accountIndex.reason);
    const apiKeyIndex = readApiKeyIndex(params);
    if (!apiKeyIndex.ok) return fail(apiKeyIndex.reason);
    const limit = readApiKeyLimit(params);
    if (!limit.ok) return fail(limit.reason);

    try {
      const response = await getLighterClient().getApiKeys(environment.value, {
        accountIndex: accountIndex.value,
        ...(apiKeyIndex.value === undefined ? {} : { apiKeyIndex: apiKeyIndex.value }),
      });
      return ok({
        ...liveProvenance(environment.value, "lighter.apiKeys.inspect", [
          LIGHTER_ENDPOINT_PATHS.apiKeys,
        ], {
          accountIndex: accountIndex.value,
          apiKeyIndex: apiKeyIndex.value ?? null,
          authenticated: false,
          outputLimit: limit.value,
        }),
        environment: environment.value,
        accountIndex: accountIndex.value,
        apiKeyIndex: apiKeyIndex.value ?? null,
        limit: limit.value,
        ...projectApiKeys(response, limit.value),
      });
    } catch (err) {
      return fail(`Lighter API-key metadata unavailable (${failureDetail("lighter.apiKeys.inspect", err)})`);
    }
  },

  "lighter.order.preview": async (params, context) => {
    const sessionId = context.sessionId;
    if (!sessionId) return fail("Lighter order preview requires a host session id.");
    const environment = readEnvironment(params);
    if (!environment.ok) return fail(environment.reason);
    const nowMs = Date.now();
    const previewParams = readLighterOrderPreviewParams(params, nowMs);
    if (!previewParams.ok) return fail(previewParams.reason);

    try {
      const client = getLighterClient();
      const accountIndex = resolvePreviewAccountIndex(
        environment.value,
        previewParams.value.accountIndex,
      );
      const [marketId, apiKeyResolution] = await Promise.all([
        resolvePreviewMarketId(client, environment.value, previewParams.value),
        resolvePreviewApiKeyIndex(
          client,
          environment.value,
          accountIndex,
          previewParams.value.apiKeyIndex,
        ),
      ]);
      const { apiKeyIndex, apiKeyLookupStatus } = apiKeyResolution;
      const [marketDetails, orderBook, account] = await Promise.all([
        client.getMarketDetails(environment.value, {
          marketId,
          filter: "all",
        }),
        client.getOrderBookOrders(environment.value, {
          marketId,
          limit: 10,
        }),
        client.getAccount(environment.value, {
          by: "index",
          value: accountIndex,
          activeOnly: true,
        }),
      ]);
      const market = findMarketDetail(marketDetails, marketId);
      if (!market) {
        return fail(
          `No live Lighter market detail found for marketId ${marketId} on ${environment.value}.`,
        );
      }
      const source = liveProvenance(environment.value, "lighter.order.preview", [
        ...(previewParams.value.marketId === undefined ? [LIGHTER_ENDPOINT_PATHS.orderBooks] : []),
        ...(previewParams.value.apiKeyIndex === null ? [LIGHTER_ENDPOINT_PATHS.apiKeys] : []),
        LIGHTER_ENDPOINT_PATHS.orderBookDetails,
        LIGHTER_ENDPOINT_PATHS.orderBookOrders,
        LIGHTER_ENDPOINT_PATHS.account,
      ], {
        marketId,
        marketSymbol: previewParams.value.marketSymbol ?? null,
        accountIndex,
        apiKeyIndex,
        apiKeyLookupStatus,
        authenticated: false,
        persistedPreview: true,
      });
      const preview = buildLighterOrderPreview({
        sessionId,
        environment: environment.value,
        accountIndex,
        apiKeyIndex,
        marketId,
        side: previewParams.value.side,
        baseAmount: previewParams.value.baseAmount,
        price: previewParams.value.price,
        orderType: previewParams.value.orderType,
        timeInForce: previewParams.value.timeInForce,
        reduceOnly: previewParams.value.reduceOnly,
        orderExpiry: previewParams.value.orderExpiry,
        clientOrderIndexPolicy: previewParams.value.clientOrderIndexPolicy,
        nowMs,
      }, {
        market,
        orderBook,
        account,
      });
      await lighterOrderPreviewsRepo.create({
        preview,
        liveSourceJson: source.provenance as Record<string, unknown>,
      });
      const approvalReady = apiKeyIndex !== null;
      return ok({
        ...source,
        status: "preview_ready",
        environment: environment.value,
        previewId: preview.previewId,
        matchHash: preview.matchHash,
        expiresAt: preview.expiresAt,
        preview: preview.preview,
        approvalReady,
        nextStep: approvalReady
          ? "prepare_for_approval"
          : "connect_trading_api_key_before_approval",
        nextToolId: approvalReady ? "lighter.order.create.prepare" : null,
        responseRules: [
          "Describe this as a live-data-backed read-only preview, not as a simulation.",
          "Do not emit raw HTML such as <br>; use Markdown bullets or sentences.",
          "Show human display values from preview.*.display fields for amounts and minimums; do not present integer fields as human ETH or USD amounts.",
          "Do not say the order can be placed, executed, submitted, or broadcast directly from this preview.",
          approvalReady
            ? "If the user wants to continue, prepare it for approval with lighter.order.create.prepare."
            : "If the user wants to continue, explain that approval preparation requires a Lighter trading API key stored in Vex's encrypted local vault with a trading API-key index from 4 to 254.",
        ],
        userGuidance: approvalReady
          ? "This is a live-data-backed preview only. Do not describe it as placed, submitted, broadcast, simulated, or ready for execution. If the user wants to continue, prepare it for approval with lighter.order.create.prepare."
          : "This is a live-data-backed read-only preview only, not a simulation. Do not describe it as placed, submitted, broadcast, or ready for execution. Preparing it for approval requires a Lighter trading API key stored in Vex's encrypted local vault with a trading API-key index from 4 to 254.",
        safety:
          "No signer, API private key, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path ran.",
      });
    } catch (err) {
      return fail(`Lighter order preview unavailable (${failureDetail("lighter.order.preview", err)})`);
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
