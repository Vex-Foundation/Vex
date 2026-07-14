import { z } from "zod";

import { endpointsForNetwork, HYPERLIQUID_REQUEST_TIMEOUT_MS, type HyperliquidNetwork } from "./constants.js";
import { HyperliquidClientError } from "./errors.js";
import type { HyperliquidClientOptions, HyperliquidRequestOptions } from "./types.js";

const infoResponseSchema = z.union([z.record(z.string(), z.unknown()), z.array(z.unknown()), z.number()]);

export type HyperliquidInfoResponse = z.infer<typeof infoResponseSchema>;

/** Read-only Hyperliquid `/info` client. Each endpoint response is root-validated. */
export class HyperliquidInfoClient {
  private readonly network: HyperliquidNetwork;
  private readonly fetchFn: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: HyperliquidClientOptions = {}) {
    this.network = options.network ?? "mainnet";
    this.fetchFn = options.fetchFn ?? fetch;
    this.timeoutMs = options.timeoutMs ?? HYPERLIQUID_REQUEST_TIMEOUT_MS;
  }

  request(type: string, payload: Record<string, unknown> = {}, options: HyperliquidRequestOptions = {}): Promise<HyperliquidInfoResponse> {
    return this.post({ type, ...payload }, options.signal);
  }

  meta(options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("meta", {}, options); }
  metaAndAssetCtxs(options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("metaAndAssetCtxs", {}, options); }
  spotMeta(options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("spotMeta", {}, options); }
  spotMetaAndAssetCtxs(options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("spotMetaAndAssetCtxs", {}, options); }
  allMids(options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("allMids", {}, options); }
  activeAssetData(user: string, coin: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("activeAssetData", { user, coin }, options); }
  clearinghouseState(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("clearinghouseState", { user }, options); }
  spotClearinghouseState(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("spotClearinghouseState", { user }, options); }
  frontendOpenOrders(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("frontendOpenOrders", { user }, options); }
  openOrders(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("openOrders", { user }, options); }
  userFills(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userFills", { user }, options); }
  userFillsByTime(user: string, startTime: number, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userFillsByTime", { user, startTime }, options); }
  userFunding(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userFunding", { user }, options); }
  userTwapSliceFills(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userTwapSliceFills", { user }, options); }
  historicalOrders(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("historicalOrders", { user }, options); }
  userFees(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userFees", { user }, options); }
  portfolio(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("portfolio", { user }, options); }
  l2Book(coin: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("l2Book", { coin }, options); }
  candleSnapshot(params: Record<string, unknown>, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> {
    // Unlike the other implemented `/info` methods, Hyperliquid requires the
    // candle request payload under `req` (mirrors the upstream InfoClient).
    return this.post({ type: "candleSnapshot", req: params }, options?.signal);
  }
  userRateLimit(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userRateLimit", { user }, options); }
  vaultDetails(vaultAddress: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("vaultDetails", { vaultAddress }, options); }
  userVaultEquities(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("userVaultEquities", { user }, options); }
  delegatorSummary(user: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("delegatorSummary", { user }, options); }
  fundingHistory(coin: string, startTime: number, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("fundingHistory", { coin, startTime }, options); }
  orderStatus(user: string, oid: number | `0x${string}`, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("orderStatus", { user, oid }, options); }
  maxBuilderFee(user: string, builder: string, options?: HyperliquidRequestOptions): Promise<HyperliquidInfoResponse> { return this.request("maxBuilderFee", { user, builder }, options); }

  private async post(payload: Record<string, unknown>, signal?: AbortSignal): Promise<HyperliquidInfoResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = (): void => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const response = await this.fetchFn(endpointsForNetwork(this.network).info, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      const raw: unknown = await response.json().catch(() => null);
      if (!response.ok) throw new HyperliquidClientError("api", `Hyperliquid info returned HTTP ${response.status}.`);
      return infoResponseSchema.parse(raw);
    } catch (cause) {
      if (cause instanceof HyperliquidClientError) throw cause;
      if (cause instanceof z.ZodError) {
        throw new HyperliquidClientError("response", "Hyperliquid info response had an unsupported root shape.", { cause });
      }
      if (controller.signal.aborted) {
        throw new HyperliquidClientError("timeout", "Hyperliquid info request timed out or was aborted.", { cause });
      }
      throw new HyperliquidClientError("transport", "Hyperliquid info request failed.", { cause });
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", abort);
    }
  }
}
