import { ErrorCodes, VexError } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import {
  LIGHTER_API_KEY_INDEX_ALL,
  LIGHTER_API_KEY_INDEX_MAX,
  LIGHTER_API_KEY_INDEX_MIN,
  LIGHTER_CANDLE_RESOLUTION_MS,
  LIGHTER_CANDLES_COUNT_MAX,
  LIGHTER_CANDLES_COUNT_MIN,
  LIGHTER_ENDPOINT_PATHS,
  LIGHTER_ENDPOINTS,
  LIGHTER_ORDER_BOOK_LIMIT_MAX,
  LIGHTER_ORDER_BOOK_LIMIT_MIN,
  LIGHTER_RECENT_TRADES_LIMIT_MAX,
  LIGHTER_RECENT_TRADES_LIMIT_MIN,
  LIGHTER_TIMESTAMP_MAX,
  LIGHTER_TIMESTAMP_MIN,
  type LighterCandleResolution,
  type LighterEndpointConfig,
  type LighterEnvironment,
} from "./constants.js";
import {
  mapLighterError,
  mapLighterSubmitError,
  mapLighterTransportError,
  readLighterErrorBody,
} from "./errors.js";
import { LighterThrottle, parseRetryAfterMs } from "./throttle.js";
import type {
  LighterAccountActiveOrdersParams,
  LighterAccountsByL1AddressParams,
  LighterAccountsByL1AddressResponse,
  LighterAccountInactiveOrdersParams,
  LighterAccountOrdersResponse,
  LighterAccountQuery,
  LighterAccountResponse,
  LighterAccountTradesParams,
  LighterAccountTradesResponse,
  LighterApiKeysParams,
  LighterApiKeysResponse,
  LighterAssetDetailsResponse,
  LighterCandlesParams,
  LighterCandlesResponse,
  LighterMarketDetailQuery,
  LighterMarketDetailsResponse,
  LighterMarketQuery,
  LighterMarketsResponse,
  LighterNextNonceParams,
  LighterNextNonceResponse,
  LighterOrderBookOrdersParams,
  LighterOrderBookOrdersResponse,
  LighterReadOnlyTokensParams,
  LighterReadOnlyTokensResponse,
  LighterRecentTradesParams,
  LighterRecentTradesResponse,
  LighterSendTxParams,
  LighterSendTxResponse,
  LighterStatusResponse,
  LighterSystemConfigResponse,
  LighterLayer1BasicInfoResponse,
  LighterInfoResponse,
  LighterTxFromL1Params,
  LighterTxFromL1Response,
  LighterTxQuery,
  LighterWithdrawalDelayResponse,
  LighterWithdrawHistoryParams,
  LighterWithdrawHistoryResponse,
} from "./types.js";
import {
  validateLighterAccount,
  validateLighterAccountsByL1Address,
  validateLighterAccountOrders,
  validateLighterAccountTrades,
  validateLighterApiKeys,
  validateLighterAssetDetails,
  validateLighterCandles,
  validateLighterMarketDetails,
  validateLighterMarkets,
  validateLighterNextNonce,
  validateLighterOrderBookOrders,
  validateLighterReadOnlyTokens,
  validateLighterRecentTrades,
  validateLighterSendTx,
  validateLighterStatus,
  validateLighterSystemConfig,
  validateLighterLayer1BasicInfo,
  validateLighterInfo,
  validateLighterTxFromL1,
  validateLighterWithdrawalDelay,
  validateLighterWithdrawHistory,
} from "./validation.js";
import {
  authorizeLighterReadOnlyAuthTokenForAccount,
  requireLighterReadOnlyAuthToken,
  type LighterReadOnlyAccountAuthorization,
} from "./credentials.js";

const REQUEST_HEADERS = {
  "User-Agent": "Vex-Agent/1.0 (+https://vexlabs.ai)",
  Accept: "application/json",
} as const;

type QueryValue = string | undefined;
type LighterAuthMode = "read-only";
export type LighterAuthTokenProvider = (
  environment: LighterEnvironment,
  mode: LighterAuthMode,
) => string;

interface RequestOptions {
  readonly auth?: LighterAuthMode;
  readonly authToken?: string;
}

export interface LighterPrivilegedAccountAuth {
  readonly token: string;
  readonly accountIndex: number;
}

export class LighterClient {
  private readonly throttle: LighterThrottle;

  constructor(
    private readonly endpoints: Record<LighterEnvironment, LighterEndpointConfig> = LIGHTER_ENDPOINTS,
    throttle = new LighterThrottle(),
    private readonly authTokenProvider: LighterAuthTokenProvider = defaultAuthTokenProvider,
  ) {
    this.throttle = throttle;
  }

  endpointFor(environment: LighterEnvironment): LighterEndpointConfig {
    const endpoint = (this.endpoints as Partial<Record<string, LighterEndpointConfig>>)[
      environment
    ];
    if (endpoint === undefined) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        `Invalid Lighter environment: ${String(environment)}`,
        "Use one of: core, rhc.",
      );
    }
    return endpoint;
  }

  private buildUrl(
    environment: LighterEnvironment,
    path: string,
    query?: Record<string, QueryValue>,
  ): string {
    const baseUrl = this.endpointFor(environment).restBaseUrl;
    const url = new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value.length > 0) {
          url.searchParams.set(key, value);
        }
      }
    }
    return url.toString();
  }

  private async request<T>(
    environment: LighterEnvironment,
    path: string,
    validator: (raw: unknown) => T,
    query?: Record<string, QueryValue>,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(environment, path, query);
    const headers = this.headersFor(environment, options.auth, options.authToken);
    try {
      const ttlMs = options.auth === undefined ? this.throttle.defaultTtlMs : 0;
      return await this.throttle.run(url, environment, ttlMs, async () => {
        const response = await fetchWithTimeout(url, { headers });

        if (!response.ok) {
          if (response.status === 429) {
            const retryMs = parseRetryAfterMs(response.headers.get("retry-after"));
            this.throttle.penalize(environment, retryMs);
          }
          throw mapLighterError(environment, response.status, await readLighterErrorBody(response));
        }

        const raw = await readJson(response);
        return validator(raw);
      });
    } catch (err) {
      mapLighterTransportError(err);
    }
  }

  private async postForm<T>(
    environment: LighterEnvironment,
    path: string,
    body: URLSearchParams,
    validator: (raw: unknown) => T,
  ): Promise<T> {
    const url = this.buildUrl(environment, path);
    try {
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: {
          ...REQUEST_HEADERS,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body,
      });

      if (!response.ok) {
        if (response.status === 429) {
          const retryMs = parseRetryAfterMs(response.headers.get("retry-after"));
          this.throttle.penalize(environment, retryMs);
        }
        await readLighterErrorBody(response);
        throw mapLighterSubmitError(environment, response.status);
      }

      const raw = await readJson(response);
      return validator(raw);
    } catch (err) {
      mapLighterTransportError(err);
    }
  }

  private headersFor(
    environment: LighterEnvironment,
    auth?: LighterAuthMode,
    authToken?: string,
  ): Record<string, string> {
    if (auth === undefined) return { ...REQUEST_HEADERS };
    return {
      ...REQUEST_HEADERS,
      Authorization: authToken ?? this.authTokenProvider(environment, auth),
    };
  }

  private readOnlyAuthForAccount(
    environment: LighterEnvironment,
    requestedAccountIndex?: number,
  ): LighterReadOnlyAccountAuthorization {
    return authorizeLighterReadOnlyAuthTokenForAccount(
      environment,
      this.authTokenProvider(environment, "read-only"),
      requestedAccountIndex,
    );
  }

  private accountAuth(
    environment: LighterEnvironment,
    requestedAccountIndex: number | undefined,
    privilegedAuth?: LighterPrivilegedAccountAuth,
  ): Pick<LighterReadOnlyAccountAuthorization, "token" | "accountIndex"> {
    if (privilegedAuth === undefined) {
      return this.readOnlyAuthForAccount(environment, requestedAccountIndex);
    }
    const accountIndex = readAccountIndex(privilegedAuth.accountIndex);
    if (requestedAccountIndex === undefined || requestedAccountIndex !== accountIndex) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        "Privileged Lighter account auth must match an explicit account index.",
      );
    }
    const token = privilegedAuth.token.trim();
    if (token.length === 0) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        "Privileged Lighter account auth token is empty.",
      );
    }
    return { token, accountIndex };
  }

  getStatus(environment: LighterEnvironment): Promise<LighterStatusResponse> {
    return this.request(environment, LIGHTER_ENDPOINT_PATHS.status, validateLighterStatus);
  }

  getInfo(environment: LighterEnvironment): Promise<LighterInfoResponse> {
    return this.request(environment, LIGHTER_ENDPOINT_PATHS.info, validateLighterInfo);
  }

  getSystemConfig(environment: LighterEnvironment): Promise<LighterSystemConfigResponse> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.systemConfig,
      validateLighterSystemConfig,
    );
  }

  getLayer1BasicInfo(environment: LighterEnvironment): Promise<LighterLayer1BasicInfoResponse> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.layer1BasicInfo,
      validateLighterLayer1BasicInfo,
    );
  }

  getAssetDetails(environment: LighterEnvironment): Promise<LighterAssetDetailsResponse> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.assetDetails,
      validateLighterAssetDetails,
    );
  }

  async getAccountsByL1Address(
    environment: LighterEnvironment,
    params: LighterAccountsByL1AddressParams,
  ): Promise<LighterAccountsByL1AddressResponse> {
    const l1Address = readNonEmptyString(params.l1Address, "l1Address");
    const cursor = params.cursor === undefined
      ? undefined
      : readNonEmptyString(params.cursor, "cursor");
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.accountsByL1Address,
      validateLighterAccountsByL1Address,
      { l1_address: l1Address, cursor },
    );
  }

  async getTxFromL1(
    environment: LighterEnvironment,
    params: LighterTxFromL1Params,
  ): Promise<LighterTxFromL1Response> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.txFromL1TxHash,
      validateLighterTxFromL1,
      { hash: readNonEmptyString(params.hash, "hash") },
    );
  }

  async getTx(
    environment: LighterEnvironment,
    params: LighterTxQuery,
  ): Promise<LighterTxFromL1Response> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.tx,
      validateLighterTxFromL1,
      {
        by: params.by,
        value: readNonEmptyString(params.value, "transaction value"),
      },
    );
  }

  getWithdrawalDelay(
    environment: LighterEnvironment,
  ): Promise<LighterWithdrawalDelayResponse> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.withdrawalDelay,
      validateLighterWithdrawalDelay,
    );
  }

  async getWithdrawHistory(
    environment: LighterEnvironment,
    params: LighterWithdrawHistoryParams,
    privilegedAuth?: LighterPrivilegedAccountAuth,
  ): Promise<LighterWithdrawHistoryResponse> {
    const auth = this.accountAuth(environment, params.accountIndex, privilegedAuth);
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.withdrawHistory,
      validateLighterWithdrawHistory,
      {
        account_index: String(readAccountIndex(auth.accountIndex)),
        cursor: params.cursor === undefined
          ? undefined
          : readNonEmptyString(params.cursor, "withdraw history cursor"),
        filter: params.filter,
      },
      { auth: "read-only", authToken: auth.token },
    );
  }

  async getAccount(
    environment: LighterEnvironment,
    params: LighterAccountQuery,
  ): Promise<LighterAccountResponse> {
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.account,
      validateLighterAccount,
      {
        by: params.by,
        value: String(params.value),
        active_only: params.activeOnly === undefined ? undefined : String(params.activeOnly),
      },
    );
  }

  async getReadOnlyTokens(
    environment: LighterEnvironment,
    params: LighterReadOnlyTokensParams,
  ): Promise<LighterReadOnlyTokensResponse> {
    const accountIndex = readAccountIndex(params.accountIndex);
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.tokens,
      validateLighterReadOnlyTokens,
      {
        account_index: String(accountIndex),
      },
      { auth: "read-only" },
    );
  }

  async getApiKeys(
    environment: LighterEnvironment,
    params: LighterApiKeysParams,
  ): Promise<LighterApiKeysResponse> {
    const accountIndex = readAccountIndex(params.accountIndex);
    const apiKeyIndex = readBoundedInt(
      params.apiKeyIndex ?? LIGHTER_API_KEY_INDEX_ALL,
      "apiKeyIndex",
      LIGHTER_API_KEY_INDEX_MIN,
      LIGHTER_API_KEY_INDEX_MAX,
    );
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.apiKeys,
      validateLighterApiKeys,
      {
        account_index: String(accountIndex),
        api_key_index: String(apiKeyIndex),
      },
    );
  }

  async getNextNonce(
    environment: LighterEnvironment,
    params: LighterNextNonceParams,
  ): Promise<LighterNextNonceResponse> {
    const accountIndex = readAccountIndex(params.accountIndex);
    const apiKeyIndex = readBoundedInt(
      params.apiKeyIndex,
      "apiKeyIndex",
      LIGHTER_API_KEY_INDEX_MIN,
      LIGHTER_API_KEY_INDEX_ALL - 1,
    );
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.nextNonce,
      validateLighterNextNonce,
      {
        account_index: String(accountIndex),
        api_key_index: String(apiKeyIndex),
      },
    );
  }

  async sendTx(
    environment: LighterEnvironment,
    params: LighterSendTxParams,
  ): Promise<LighterSendTxResponse> {
    const txType = readBoundedInt(params.txType, "txType", 0, 255);
    const txInfo = params.txInfo.trim();
    if (txInfo.length === 0) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        "Invalid Lighter txInfo: expected signed transaction info",
      );
    }

    const body = new URLSearchParams();
    body.set("tx_type", String(txType));
    body.set("tx_info", txInfo);
    if (params.priceProtection !== undefined) {
      body.set("price_protection", String(params.priceProtection));
    }

    return this.postForm(
      environment,
      LIGHTER_ENDPOINT_PATHS.sendTx,
      body,
      validateLighterSendTx,
    );
  }

  async getAccountActiveOrders(
    environment: LighterEnvironment,
    params: LighterAccountActiveOrdersParams,
    privilegedAuth?: LighterPrivilegedAccountAuth,
  ): Promise<LighterAccountOrdersResponse> {
    const auth = this.accountAuth(environment, params.accountIndex, privilegedAuth);
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.accountActiveOrders,
      validateLighterAccountOrders,
      buildAccountOrdersQuery({ ...params, accountIndex: auth.accountIndex }),
      { auth: "read-only", authToken: auth.token },
    );
  }

  async getAccountInactiveOrders(
    environment: LighterEnvironment,
    params: LighterAccountInactiveOrdersParams,
    privilegedAuth?: LighterPrivilegedAccountAuth,
  ): Promise<LighterAccountOrdersResponse> {
    const auth = this.accountAuth(environment, params.accountIndex, privilegedAuth);
    const limit = readBoundedInt(
      params.limit ?? 25,
      "limit",
      LIGHTER_RECENT_TRADES_LIMIT_MIN,
      LIGHTER_RECENT_TRADES_LIMIT_MAX,
    );
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.accountInactiveOrders,
      validateLighterAccountOrders,
      {
        ...buildAccountOrdersQuery({ ...params, accountIndex: auth.accountIndex }),
        limit: String(limit),
      },
      { auth: "read-only", authToken: auth.token },
    );
  }

  async getMarkets(
    environment: LighterEnvironment,
    params: LighterMarketQuery = {},
  ): Promise<LighterMarketsResponse> {
    const query: Record<string, QueryValue> = {};
    if (params.marketId !== undefined) query.market_id = String(readUint16(params.marketId, "marketId"));
    if (params.filter !== undefined) query.filter = params.filter;
    return this.request(environment, LIGHTER_ENDPOINT_PATHS.orderBooks, validateLighterMarkets, query);
  }

  async getMarketDetails(
    environment: LighterEnvironment,
    params: LighterMarketDetailQuery,
  ): Promise<LighterMarketDetailsResponse> {
    const marketId = readUint16(params.marketId, "marketId");
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.orderBookDetails,
      validateLighterMarketDetails,
      {
        market_id: String(marketId),
        filter: params.filter,
      },
    );
  }

  async getOrderBookOrders(
    environment: LighterEnvironment,
    params: LighterOrderBookOrdersParams,
  ): Promise<LighterOrderBookOrdersResponse> {
    const marketId = readUint16(params.marketId, "marketId");
    const limit = readBoundedInt(
      params.limit ?? 25,
      "limit",
      LIGHTER_ORDER_BOOK_LIMIT_MIN,
      LIGHTER_ORDER_BOOK_LIMIT_MAX,
    );
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.orderBookOrders,
      validateLighterOrderBookOrders,
      {
        market_id: String(marketId),
        limit: String(limit),
      },
    );
  }

  async getRecentTrades(
    environment: LighterEnvironment,
    params: LighterRecentTradesParams,
  ): Promise<LighterRecentTradesResponse> {
    const marketId = readUint16(params.marketId, "marketId");
    const limit = readBoundedInt(
      params.limit ?? 25,
      "limit",
      LIGHTER_RECENT_TRADES_LIMIT_MIN,
      LIGHTER_RECENT_TRADES_LIMIT_MAX,
    );
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.recentTrades,
      validateLighterRecentTrades,
      {
        market_id: String(marketId),
        limit: String(limit),
      },
    );
  }

  async getAccountTrades(
    environment: LighterEnvironment,
    params: LighterAccountTradesParams,
    privilegedAuth?: LighterPrivilegedAccountAuth,
  ): Promise<LighterAccountTradesResponse> {
    const auth = this.accountAuth(environment, params.accountIndex, privilegedAuth);
    const accountIndex = readAccountIndex(auth.accountIndex);
    const limit = readBoundedInt(
      params.limit ?? 25,
      "limit",
      LIGHTER_RECENT_TRADES_LIMIT_MIN,
      LIGHTER_RECENT_TRADES_LIMIT_MAX,
    );
    return this.request(
      environment,
      LIGHTER_ENDPOINT_PATHS.trades,
      validateLighterAccountTrades,
      {
        account_index: String(accountIndex),
        limit: String(limit),
        sort_by: params.sortBy ?? "timestamp",
      },
      { auth: "read-only", authToken: auth.token },
    );
  }

  async getCandles(
    environment: LighterEnvironment,
    params: LighterCandlesParams,
  ): Promise<LighterCandlesResponse> {
    const query = buildCandlesQuery(params);
    const response = await this.requestCandles(environment, query);
    if (response.c.length > LIGHTER_CANDLES_COUNT_MAX) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_RESPONSE,
        `Lighter candles response exceeded ${LIGHTER_CANDLES_COUNT_MAX} rows`,
        "Narrow the candle time range before retrying.",
      );
    }
    return response;
  }

  private async requestCandles(
    environment: LighterEnvironment,
    query: Record<string, QueryValue>,
  ): Promise<LighterCandlesResponse> {
    const url = this.buildUrl(environment, LIGHTER_ENDPOINT_PATHS.candles, query);
    const headers = this.headersFor(environment);
    try {
      return await this.throttle.run(url, environment, this.throttle.defaultTtlMs, async () => {
        const response = await fetchWithTimeout(url, { headers });
        if (!response.ok) {
          if (response.status === 429) {
            const retryMs = parseRetryAfterMs(response.headers.get("retry-after"));
            this.throttle.penalize(environment, retryMs);
          }
          throw mapLighterError(
            environment,
            response.status,
            await readLighterErrorBody(response),
          );
        }
        return validateLighterCandles(await readExactCandleJson(response));
      });
    } catch (err) {
      mapLighterTransportError(err);
    }
  }
}

async function readExactCandleJson(response: Response): Promise<unknown> {
  try {
    const textReader = (response as Response & { text?: () => Promise<string> }).text;
    const text = typeof textReader === "function"
      ? await textReader.call(response)
      : JSON.stringify(await response.json());
    // JSON.parse would round a provider integer before validation. Quote only
    // candle last-trade ids so their original decimal lexemes remain lossless.
    const exact = text.replace(
      /(\"i\"\s*:\s*)(-?\d+)(?=\s*[,}])/g,
      (_match, prefix: string, value: string) => `${prefix}\"${value}\"`,
    );
    return JSON.parse(exact) as unknown;
  } catch {
    return null;
  }
}

function readUint16(value: number, field: string): number {
  return readBoundedInt(value, field, 0, 65_535);
}

function readNonEmptyString(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Invalid Lighter ${field}: expected a non-empty string`,
    );
  }
  return normalized;
}

function readAccountIndex(value: number): number {
  return readBoundedInt(value, "accountIndex", 0, Number.MAX_SAFE_INTEGER);
}

function buildAccountOrdersQuery(
  params: LighterAccountActiveOrdersParams & { readonly accountIndex: number },
): Record<string, QueryValue> {
  const accountIndex = readAccountIndex(params.accountIndex);
  const marketId = params.marketId === undefined ? undefined : readUint16(params.marketId, "marketId");
  return {
    account_index: String(accountIndex),
    market_id: marketId === undefined ? undefined : String(marketId),
    market_type: params.marketType,
  };
}

function readBoundedInt(value: number, field: string, min: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < min || value > max) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Invalid Lighter ${field}: expected an integer from ${min} to ${max}`,
    );
  }
  return value;
}

function readTimestamp(value: number, field: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Invalid Lighter ${field}: expected an epoch-milliseconds integer`,
    );
  }
  if (value < LIGHTER_TIMESTAMP_MIN) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Invalid Lighter ${field}: expected epoch milliseconds, not seconds`,
      "Pass JavaScript epoch milliseconds, for example Date.now().",
    );
  }
  if (value > LIGHTER_TIMESTAMP_MAX) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      `Invalid Lighter ${field}: timestamp is too far in the future`,
    );
  }
  return value;
}

function buildCandlesQuery(params: LighterCandlesParams): Record<string, QueryValue> {
  const marketId = readUint16(params.marketId, "marketId");
  const startTimestamp = readTimestamp(params.startTimestamp, "startTimestamp");
  const endTimestamp = readTimestamp(params.endTimestamp, "endTimestamp");
  if (endTimestamp <= startTimestamp) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Invalid Lighter candle range: endTimestamp must be greater than startTimestamp",
    );
  }

  const resolutionMs = resolutionToMs(params.resolution);
  const rangeCandles = Math.ceil((endTimestamp - startTimestamp) / resolutionMs);
  const countBack =
    params.countBack === undefined
      ? readBoundedInt(rangeCandles, "countBack", LIGHTER_CANDLES_COUNT_MIN, LIGHTER_CANDLES_COUNT_MAX)
      : readBoundedInt(
          params.countBack,
          "countBack",
          LIGHTER_CANDLES_COUNT_MIN,
          LIGHTER_CANDLES_COUNT_MAX,
        );

  if (rangeCandles > countBack) {
    throw new VexError(
      ErrorCodes.LIGHTER_INVALID_REQUEST,
      "Invalid Lighter candle range: range exceeds countBack at the requested resolution",
      "Narrow the time range or increase countBack up to 500.",
    );
  }

  return {
    market_id: String(marketId),
    resolution: params.resolution,
    start_timestamp: String(startTimestamp),
    end_timestamp: String(endTimestamp),
    count_back: String(countBack),
    set_timestamp_to_end:
      params.setTimestampToEnd === undefined ? undefined : String(params.setTimestampToEnd),
  };
}

function resolutionToMs(resolution: LighterCandleResolution): number {
  return LIGHTER_CANDLE_RESOLUTION_MS[resolution];
}

let cachedClient: LighterClient | null = null;

const defaultAuthTokenProvider: LighterAuthTokenProvider = (environment, mode) => {
  if (mode === "read-only") return requireLighterReadOnlyAuthToken(environment);
  throw new VexError(
    ErrorCodes.LIGHTER_INVALID_REQUEST,
    `Unsupported Lighter auth mode: ${String(mode)}`,
  );
};

export function getLighterClient(): LighterClient {
  if (cachedClient) return cachedClient;
  cachedClient = new LighterClient();
  return cachedClient;
}
