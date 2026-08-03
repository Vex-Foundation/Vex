/**
 * KyberSwap Aggregator API client.
 *
 * V1 two-step swap: GET /{chain}/api/v1/routes → POST /{chain}/api/v1/route/build
 * Singleton via getKyberAggregatorClient().
 */

import { loadConfig } from "../../../config/store.js";
import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import { mapKyberTransportError, readKyberErrorBody } from "../errors.js";
import { mapAggregatorError } from "./errors.js";
import { validateSwapRouteResponse, validateSwapBuildResponse } from "./validation.js";
import { KYBERSWAP_REQUEST_HEADERS, AGGREGATOR_TIMEOUT_MS } from "../constants.js";
import logger from "../../../utils/logger.js";
import type { KyberChainSlug } from "../types.js";
import type { SwapRouteParams, SwapRouteResponse, SwapBuildRequest, SwapBuildResponse } from "./types.js";

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export class KyberAggregatorClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = AGGREGATOR_TIMEOUT_MS,
  ) {}

  private buildUrl(chain: KyberChainSlug, path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(`/${chain}${path}`, this.baseUrl);
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
    chain: KyberChainSlug,
    path: string,
    validator: (raw: unknown) => T,
    options: RequestOptions = {},
  ): Promise<T> {
    const url = this.buildUrl(chain, path, options.query);
    const method = options.method ?? "GET";

    try {
      logger.debug({ event: "kyberswap.aggregator.request.start", chain, path, method });

      const response = await fetchWithTimeout(url, {
        method,
        headers: {
          ...KYBERSWAP_REQUEST_HEADERS,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : undefined),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        timeoutMs: this.timeoutMs,
      });

      if (!response.ok) {
        // Reads the body WHATEVER its content type: an edge challenge answers
        // HTML, and `readJson` used to drop it, leaving a bare "HTTP 403".
        const body = await readKyberErrorBody(response);

        logger.warn({
          event: "kyberswap.aggregator.request.error",
          chain,
          path,
          status: response.status,
          code: body.code,
          requestId: body.requestId,
        });
        throw mapAggregatorError(response.status, body.code, body.message, body.requestId);
      }

      const raw = await readJson(response);
      const result = validator(raw);

      logger.debug({ event: "kyberswap.aggregator.request.success", chain, path });
      return result;
    } catch (err) {
      mapKyberTransportError(err);
    }
  }

  /** Get the best swap route. Read-only, no wallet needed. */
  getRoute(chain: KyberChainSlug, params: SwapRouteParams): Promise<SwapRouteResponse> {
    const query: Record<string, string | undefined> = {
      tokenIn: params.tokenIn,
      tokenOut: params.tokenOut,
      amountIn: params.amountIn,
      includedSources: params.includedSources,
      excludedSources: params.excludedSources,
      excludeRFQSources: params.excludeRFQSources != null ? String(params.excludeRFQSources) : undefined,
      onlyScalableSources: params.onlyScalableSources != null ? String(params.onlyScalableSources) : undefined,
      onlyDirectPools: params.onlyDirectPools != null ? String(params.onlyDirectPools) : undefined,
      onlySinglePath: params.onlySinglePath != null ? String(params.onlySinglePath) : undefined,
      gasInclude: params.gasInclude != null ? String(params.gasInclude) : undefined,
      gasPrice: params.gasPrice,
      origin: params.origin,
      feeAmount: params.feeAmount,
      chargeFeeBy: params.chargeFeeBy,
      isInBps: params.isInBps != null ? String(params.isInBps) : undefined,
      feeReceiver: params.feeReceiver,
    };

    return this.request(chain, "/api/v1/routes", validateSwapRouteResponse, { query });
  }

  /** Build encoded swap transaction data from a route. */
  buildRoute(chain: KyberChainSlug, body: SwapBuildRequest): Promise<SwapBuildResponse> {
    return this.request(chain, "/api/v1/route/build", validateSwapBuildResponse, {
      method: "POST",
      body,
    });
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: KyberAggregatorClient | null = null;
let cachedBaseUrl: string | null = null;

export function getKyberAggregatorClient(): KyberAggregatorClient {
  const baseUrl = loadConfig().services.kyberswapAggregatorUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }
  cachedClient = new KyberAggregatorClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
