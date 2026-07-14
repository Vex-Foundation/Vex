/**
 * KyberSwap Limit Order client — Maker flows.
 *
 * Sign message → create → query → cancel (gasless/hard).
 * Singleton via getKyberLimitOrderClient().
 */

import { loadConfig } from "../../../config/store.js";
import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import { isRecord } from "../../../utils/validation-helpers.js";
import { mapKyberTransportError } from "../errors.js";
import { mapLimitOrderError } from "./errors.js";
import { KYBER_CLIENT_ID, LIMIT_ORDER_TIMEOUT_MS } from "../constants.js";
import {
  validateEip712Message,
  validateCreateOrderResponse,
  validateOrdersResponse,
  validateActiveMakingAmount,
  validateEncodedCalldata,
  validateContractAddressResponse,
} from "./validation.js";
import logger from "../../../utils/logger.js";
import type { VexError } from "../../../errors.js";
import type {
  LimitOrder,
  LimitOrderSignMessageRequest,
  LimitOrderEip712Message,
  LimitOrderCreateRequest,
  LimitOrderCancelSignRequest,
  EncodedCalldata,
  ContractAddresses,
} from "./types.js";

interface RequestOptions {
  method?: "GET" | "POST";
  query?: Record<string, string | undefined>;
  body?: unknown;
}

export class KyberLimitOrderClient {
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

  private async request<T>(path: string, validator: (raw: unknown) => T, options: RequestOptions = {}): Promise<T> {
    const url = this.buildUrl(path, options.query);
    const method = options.method ?? "GET";

    try {
      logger.debug({ event: "kyberswap.limit_order.request.start", path, method });

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
        logger.warn({ event: "kyberswap.limit_order.request.error", path, status: response.status });
        throw mapLimitOrderError(response.status, message);
      }

      const raw = await readJson(response);
      const result = validator(raw);
      logger.debug({ event: "kyberswap.limit_order.request.success", path });
      return result;
    } catch (err) {
      if ((err as VexError).code?.startsWith("KYBER_")) throw err;
      mapKyberTransportError(err);
    }
  }

  /** Get contract addresses per chain for limit orders. */
  getContractAddresses(): Promise<ContractAddresses> {
    return this.request("/read-ks/api/v1/configs/contract-address", validateContractAddressResponse);
  }

  /** Get unsigned EIP-712 message for order creation. */
  getSignMessage(body: LimitOrderSignMessageRequest): Promise<LimitOrderEip712Message> {
    return this.request("/write/api/v1/orders/sign-message", validateEip712Message, { method: "POST", body });
  }

  /** Submit signed order to orderbook. */
  createOrder(body: LimitOrderCreateRequest): Promise<{ orderId: number }> {
    return this.request("/write/api/v1/orders", validateCreateOrderResponse, { method: "POST", body });
  }

  /** Query maker's orders. */
  getOrders(params: { chainId: string; maker?: string; status?: string; page?: string; pageSize?: string }): Promise<LimitOrder[]> {
    return this.request("/read-ks/api/v1/orders", validateOrdersResponse, { query: params as Record<string, string | undefined> });
  }

  /** Get total active making amount for allowance check. */
  getActiveMakingAmount(chainId: string, makerAsset: string, maker: string): Promise<string> {
    return this.request("/read-ks/api/v1/orders/active-making-amount", validateActiveMakingAmount, {
      query: { chainId, makerAsset, maker },
    });
  }

  /** Get unsigned EIP-712 message for gasless cancel. */
  getCancelSignMessage(body: LimitOrderCancelSignRequest): Promise<LimitOrderEip712Message> {
    return this.request("/write/api/v1/orders/cancel-sign", validateEip712Message, { method: "POST", body });
  }

  /** Submit signed gasless cancel. */
  cancelOrders(body: LimitOrderEip712Message & { signature: string }): Promise<void> {
    return this.request("/write/api/v1/orders/cancel", () => undefined, { method: "POST", body });
  }

  /** Encode on-chain cancel-batch transaction. */
  encodeCancelBatch(orderIds: number[]): Promise<EncodedCalldata> {
    return this.request("/read-ks/api/v1/encode/cancel-batch-orders", validateEncodedCalldata, {
      method: "POST",
      body: { orderIds },
    });
  }

  /** Encode on-chain increase-nonce transaction (cancels all orders). */
  encodeIncreaseNonce(chainId: string): Promise<EncodedCalldata> {
    return this.request("/read-ks/api/v1/encode/increase-nonce", validateEncodedCalldata, {
      method: "POST",
      body: { chainId },
    });
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: KyberLimitOrderClient | null = null;
let cachedBaseUrl: string | null = null;

export function getKyberLimitOrderClient(): KyberLimitOrderClient {
  const baseUrl = loadConfig().services.kyberswapLimitOrderUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) return cachedClient;
  cachedClient = new KyberLimitOrderClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
