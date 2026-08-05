/**
 * KyberSwap Token API client.
 *
 * Token search and honeypot/fee-on-transfer detection.
 * Singleton via getKyberTokenApiClient().
 */

import { loadConfig } from "../../../config/store.js";
import { fetchWithTimeout, readJson } from "../../../utils/http.js";
import { VexError, ErrorCodes } from "../../../errors.js";
import { carryStatus, mapKyberTransportError, readKyberErrorBody } from "../errors.js";
import { validateTokenSearchResponse, validateHoneypotFotResponse } from "./validation.js";
import { TOKEN_API_TIMEOUT_MS, KYBERSWAP_REQUEST_HEADERS } from "../constants.js";
import logger from "../../../utils/logger.js";
import type { KyberToken, KyberTokenSearchResponse, HoneypotFotInfo } from "./types.js";

export class KyberTokenApiClient {
  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = TOKEN_API_TIMEOUT_MS,
  ) {}

  private buildUrl(path: string, query: Record<string, string | undefined>): string {
    const url = new URL(path, this.baseUrl);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value.length > 0) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  /**
   * Search tokens by name/symbol across chains.
   *
   * @param chainIds - Comma-separated chain IDs (e.g. "1,56,42161")
   */
  async searchTokens(
    chainIds: string,
    opts?: { name?: string; isWhitelisted?: boolean; page?: number; pageSize?: number },
  ): Promise<KyberToken[]> {
    try {
      logger.debug({ event: "kyberswap.token_api.search.start", chainIds, name: opts?.name });

      const url = this.buildUrl("/api/v1/public/tokens", {
        chainIds,
        name: opts?.name,
        isWhitelisted: opts?.isWhitelisted != null ? String(opts.isWhitelisted) : undefined,
        page: opts?.page != null ? String(opts.page) : undefined,
        pageSize: opts?.pageSize != null ? String(opts.pageSize) : undefined,
      });

      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers: { ...KYBERSWAP_REQUEST_HEADERS },
      });

      if (!response.ok) {
        const body = await readKyberErrorBody(response);
        throw carryStatus(
          new VexError(ErrorCodes.KYBER_TOKEN_SEARCH_FAILED, `Token search failed: ${body.message}`),
          response.status,
        );
      }

      const raw = await readJson(response);
      const result = validateTokenSearchResponse(raw);

      logger.debug({ event: "kyberswap.token_api.search.success", count: result.data.tokens.length });
      return result.data.tokens;
    } catch (err) {
      if (err instanceof VexError && err.code.startsWith("KYBER_")) throw err;
      mapKyberTransportError(err);
    }
  }

  /**
   * Check if a token is a honeypot or has fee-on-transfer tax.
   */
  async getHoneypotFotInfo(chainId: number, address: string): Promise<HoneypotFotInfo> {
    try {
      logger.debug({ event: "kyberswap.token_api.honeypot.start", chainId, address });

      const url = this.buildUrl("/api/v1/public/tokens/honeypot-fot-info", {
        chainId: String(chainId),
        address,
      });

      const response = await fetchWithTimeout(url, {
        timeoutMs: this.timeoutMs,
        headers: { ...KYBERSWAP_REQUEST_HEADERS },
      });

      if (!response.ok) {
        const body = await readKyberErrorBody(response);
        throw carryStatus(
          new VexError(ErrorCodes.KYBER_HONEYPOT_CHECK_FAILED, `Honeypot check failed: ${body.message}`),
          response.status,
        );
      }

      const raw = await readJson(response);
      const result = validateHoneypotFotResponse(raw);

      logger.debug({ event: "kyberswap.token_api.honeypot.success", chainId, address, isHoneypot: result.isHoneypot });
      return result;
    } catch (err) {
      if (err instanceof VexError && err.code.startsWith("KYBER_")) throw err;
      mapKyberTransportError(err);
    }
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: KyberTokenApiClient | null = null;
let cachedBaseUrl: string | null = null;

export function getKyberTokenApiClient(): KyberTokenApiClient {
  const baseUrl = loadConfig().services.kyberswapTokenApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }
  cachedClient = new KyberTokenApiClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
