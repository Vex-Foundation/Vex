/**
 * KyberSwap Common Service client.
 *
 * Provides dynamic chain discovery. Singleton via getKyberCommonClient().
 */

import { loadConfig } from "../../../config/store.js";
import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import { carryStatus, mapKyberTransportError, readKyberErrorBody } from "../errors.js";
import { VexError, ErrorCodes } from "../../../errors.js";
import { validateSupportedChainsResponse } from "./validation.js";
import { COMMON_SERVICE_TIMEOUT_MS, KYBERSWAP_REQUEST_HEADERS } from "../constants.js";
import { setCachedDynamicChains, getCachedDynamicChains } from "../chains.js";
import logger from "../../../utils/logger.js";
import type { KyberChainInfo } from "../types.js";

export class KyberCommonClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = COMMON_SERVICE_TIMEOUT_MS,
  ) {}

  /** Fetch supported chains from Common Service, with 1h in-memory cache. */
  async getSupportedChains(): Promise<KyberChainInfo[]> {
    const cached = getCachedDynamicChains();
    if (cached) return cached;

    try {
      logger.debug({ event: "kyberswap.common.supported_chains.start" });

      const url = `${this.baseUrl}/api/v1/aggregator/supported-chains`;
      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers: { ...KYBERSWAP_REQUEST_HEADERS },
      });

      if (!response.ok) {
        const body = await readKyberErrorBody(response);
        throw carryStatus(
          new VexError(ErrorCodes.KYBER_API_ERROR, `KyberSwap Common Service error: ${body.message}`),
          response.status,
        );
      }

      const raw = await readJson(response);
      const chains = validateSupportedChainsResponse(raw);
      setCachedDynamicChains(chains);

      logger.debug({ event: "kyberswap.common.supported_chains.success", count: chains.length });
      return chains;
    } catch (err) {
      mapKyberTransportError(err);
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: KyberCommonClient | null = null;
let cachedBaseUrl: string | null = null;

export function getKyberCommonClient(): KyberCommonClient {
  const baseUrl = loadConfig().services.kyberswapCommonServiceUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }
  cachedClient = new KyberCommonClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
