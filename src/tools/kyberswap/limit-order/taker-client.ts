/**
 * KyberSwap Limit Order taker client.
 *
 * Query orders → get operator signature → fill order(s).
 * Singleton via getKyberLimitOrderTakerClient().
 */

import { loadConfig } from "../../../config/store.js";
import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import { mapKyberTransportError } from "../errors.js";
import { mapLimitOrderError } from "./errors.js";
import { KYBER_CLIENT_ID, LIMIT_ORDER_TIMEOUT_MS } from "../constants.js";
import { validateOrdersResponse, validateOperatorSignature, validateEncodedCalldata, validateTradingPairsResponse } from "./validation.js";
import logger from "../../../utils/logger.js";
import type { VexError } from "../../../errors.js";
import type { LimitOrder, OperatorSignatureResponse, FillOrderRequest, FillBatchOrdersRequest, EncodedCalldata, TradingPair } from "./types.js";

export class KyberLimitOrderTakerClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = LIMIT_ORDER_TIMEOUT_MS,
  ) {}

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.baseUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value.length > 0) url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private async request<T>(path: string, validator: (raw: unknown) => T, options: { method?: string; query?: Record<string, string | undefined>; body?: unknown } = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const method = options.method ?? "GET";

    try {
      logger.debug({ event: "kyberswap.limit_order_taker.request.start", path, method });

      const response = await fetchWithTimeout(url, {
        method,
        headers: {
          "X-Client-Id": KYBER_CLIENT_ID,
          ...(options.body !== undefined ? { "Content-Type": "application/json" } : undefined),
        },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        timeoutMs: this.timeoutMs,
      });

      if (!response.ok) {
        const raw = await readJson(response);
        const message = isRecord(raw) && typeof raw.message === "string" ? raw.message : `HTTP ${response.status}`;
        logger.warn({ event: "kyberswap.limit_order_taker.request.error", path, status: response.status });
        throw mapLimitOrderError(response.status, message);
      }

      const raw = await readJson(response);
      const result = validator(raw);
      logger.debug({ event: "kyberswap.limit_order_taker.request.success", path });
      return result;
    } catch (err) {
      if ((err as VexError).code?.startsWith("KYBER_")) throw err;
      mapKyberTransportError(err);
    }
  }

  /** Query supported trading pairs. */
  getTradingPairs(chainId: string): Promise<TradingPair[]> {
    return this.request("/read-partner/api/v1/orders/pairs", validateTradingPairsResponse, {
      query: { chainId },
    });
  }

  /** Query available orders as a taker. */
  getTakerOrders(params: { chainId: string; makerAsset?: string; takerAsset?: string }): Promise<LimitOrder[]> {
    return this.request("/read-partner/api/v1/orders", validateOrdersResponse, {
      query: params as Record<string, string | undefined>,
    });
  }

  /** Get operator signature required for order filling. */
  getOperatorSignature(chainId: string, orderIds: number[]): Promise<OperatorSignatureResponse> {
    return this.request("/read-partner/api/v1/orders/operator-signature", validateOperatorSignature, {
      query: { chainId, orderIds: orderIds.join(",") },
    });
  }

  /** Encode single order fill transaction. */
  encodeFillOrder(body: FillOrderRequest): Promise<EncodedCalldata> {
    return this.request("/read-ks/api/v1/encode/fill-order-to", validateEncodedCalldata, {
      method: "POST", body,
    });
  }

  /** Encode batch order fill transaction. */
  encodeFillBatchOrders(body: FillBatchOrdersRequest): Promise<EncodedCalldata> {
    return this.request("/read-ks/api/v1/encode/fill-batch-orders-to", validateEncodedCalldata, {
      method: "POST", body,
    });
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: KyberLimitOrderTakerClient | null = null;
let cachedBaseUrl: string | null = null;

export function getKyberLimitOrderTakerClient(): KyberLimitOrderTakerClient {
  const baseUrl = loadConfig().services.kyberswapLimitOrderUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new KyberLimitOrderTakerClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
