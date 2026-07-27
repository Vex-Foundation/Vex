/**
 * DexScreener REST API client.
 *
 * Wraps all public DexScreener endpoints with typed responses
 * and runtime validation. Singleton via getDexScreenerClient().
 */

import { loadConfig } from "../../config/store.js";
import { VexError } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import { mapDexScreenerError, mapTransportError } from "./errors.js";
import {
  DexScreenerThrottle,
  cacheTtlForClass,
  classifyRateClass,
  parseRetryAfterMs,
} from "./throttle.js";
import type {
  DexAd,
  DexBoostFeed,
  DexCommunityTakeover,
  DexMeta,
  DexMetaDetail,
  DexOrdersResponse,
  DexPair,
  DexProfileUpdate,
  DexTokenProfile,
  PairsResponse,
  SearchResponse,
  TokensPairsResponse,
  TokensResponse,
} from "./types.js";
import {
  validateAdsResponse,
  validateBoostsResponse,
  validateCommunityTakeoversResponse,
  validateOrdersResponse,
  validatePairsResponse,
  validateProfilesResponse,
  validateSearchResponse,
  validateTokensPairsResponse,
  validateTokensResponse,
} from "./validation.js";
import { validateMetaDetailResponse, validateMetasTrendingResponse } from "./validation/metas.js";
import { validateProfilesRecentResponse } from "./validation/profiles.js";

export class DexScreenerClient {
  private readonly throttle: DexScreenerThrottle;

  constructor(private readonly baseUrl: string) {
    // Per-process throttle + cache shared by every consumer of this client.
    this.throttle = new DexScreenerThrottle();
  }

  private buildUrl(path: string, query?: Record<string, string | undefined>): string {
    const url = new URL(path, this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`);
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
    path: string,
    validator: (raw: unknown) => T,
    query?: Record<string, string | undefined>,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const rateClass = classifyRateClass(path);
    const ttlMs = cacheTtlForClass(rateClass);
    // The normalized request URL (path + ordered query) is the cache/dedupe key.
    try {
      return await this.throttle.run(url, rateClass, ttlMs, async () => {
        const response = await fetchWithTimeout(url);

        if (!response.ok) {
          if (response.status === 429) {
            // Optional chaining guards test doubles that omit `headers`.
            const retryMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
            this.throttle.penalize(rateClass, retryMs);
          }
          const raw = await readJson(response);
          const message = typeof raw === "object" && raw !== null && "error" in raw
            ? String((raw as Record<string, unknown>).error)
            : undefined;
          throw mapDexScreenerError(response.status, message);
        }

        const raw = await readJson(response);
        return validator(raw);
      });
    } catch (err) {
      mapTransportError(err);
    }
  }

  // ── Core DEX data ───────────────────────────────────────────────

  /** Search DEX pairs across all chains. */
  search(query: string): Promise<SearchResponse> {
    return this.request("/latest/dex/search", validateSearchResponse, { q: query });
  }

  /** Get pair details by chain and pair address. */
  getPairs(chainId: string, pairId: string): Promise<PairsResponse> {
    return this.request(
      `/latest/dex/pairs/${encodeURIComponent(chainId)}/${encodeURIComponent(pairId)}`,
      validatePairsResponse,
    );
  }

  /** Get all pair data for one or more tokens (comma-separated, max 30). */
  getTokens(chainId: string, tokenAddresses: string): Promise<TokensResponse> {
    return this.request(
      `/tokens/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddresses)}`,
      validateTokensResponse,
    );
  }

  /** Get all trading pools for a specific token. */
  getTokenPairs(chainId: string, tokenAddress: string): Promise<TokensPairsResponse> {
    return this.request(
      `/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      validateTokensPairsResponse,
    );
  }

  // ── Profiles & boosts ─────────────────────────────────────────

  /** Get latest trending token profiles. */
  getProfiles(): Promise<DexTokenProfile[]> {
    return this.request("/token-profiles/latest/v1", validateProfilesResponse);
  }

  /** Get latest boosted tokens (this feed sends `amount` AND `totalAmount`). */
  getBoosts(): Promise<DexBoostFeed> {
    return this.request("/token-boosts/latest/v1", validateBoostsResponse);
  }

  /** Get tokens with most active boosts (this feed sends `totalAmount` only). */
  getTopBoosts(): Promise<DexBoostFeed> {
    return this.request("/token-boosts/top/v1", validateBoostsResponse);
  }

  // ── Community Takeovers ──────────────────────────────────────

  /** Get latest community takeovers. */
  getCommunityTakeovers(): Promise<DexCommunityTakeover[]> {
    return this.request("/community-takeovers/latest/v1", validateCommunityTakeoversResponse);
  }

  // ── Ads ─────────────────────────────────────────────────────

  /** Get latest ads. */
  getAds(): Promise<DexAd[]> {
    return this.request("/ads/latest/v1", validateAdsResponse);
  }

  /** Get recently updated token profiles (live, undocumented feed). */
  getProfilesRecentUpdates(): Promise<DexProfileUpdate[]> {
    return this.request("/token-profiles/recent-updates/v1", validateProfilesRecentResponse);
  }

  // ── Metas / narratives (live, undocumented) ──────────────────

  /**
   * Get the trending NARRATIVES/themes feed (live, undocumented endpoint).
   * Returns categories (e.g. "ai", "dog", "knockoff-legends"), NOT tokens.
   */
  getMetasTrending(): Promise<DexMeta[]> {
    return this.request("/metas/trending/v1", validateMetasTrendingResponse);
  }

  /**
   * Get one narrative plus its DEX pairs by `slug` (live, undocumented). The
   * `slug` is a NARRATIVE slug from `getMetasTrending()` (e.g. "knockoff-legends"),
   * NOT a chain slug. Returns `null` when the feed is unavailable or drifted.
   */
  getMeta(slug: string): Promise<DexMetaDetail | null> {
    return this.request(
      `/metas/meta/v1/${encodeURIComponent(slug)}`,
      validateMetaDetailResponse,
    );
  }

  // ── Orders ────────────────────────────────────────────────────

  /** Check paid orders for a token, plus the sibling boost-payment ledger. */
  getOrders(chainId: string, tokenAddress: string): Promise<DexOrdersResponse> {
    return this.request(
      `/orders/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      validateOrdersResponse,
    );
  }
}

// ── Singleton ───────────────────────────────────────────────────────

let cachedClient: DexScreenerClient | null = null;
let cachedBaseUrl: string | null = null;

export function getDexScreenerClient(): DexScreenerClient {
  const baseUrl = loadConfig().services.dexScreenerApiUrl;
  if (cachedClient && cachedBaseUrl === baseUrl) {
    return cachedClient;
  }

  cachedClient = new DexScreenerClient(baseUrl);
  cachedBaseUrl = baseUrl;
  return cachedClient;
}
