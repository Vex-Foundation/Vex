/**
 * DexScreener REST API client.
 *
 * Wraps all public DexScreener endpoints with typed responses
 * and runtime validation. Singleton via getDexScreenerClient().
 */

import { loadConfig } from "../../config/store.js";
import { VexError, ErrorCodes } from "../../errors.js";
import { fetchWithTimeout, readJson } from "../../utils/http.js";
import { mapDexScreenerError, mapTransportError } from "./errors.js";
import {
  DexScreenerThrottle,
  cacheTtlForClass,
  classifyRateClass,
  parseRetryAfterMs,
} from "./throttle.js";
import type { DexScreenerObserved } from "./throttle.js";
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

/**
 * Descriptive UA + explicit Accept, sent on every request.
 *
 * Not cosmetic: DexScreener sits behind Cloudflare, and KyberSwap proved
 * live (2026-08-03) that a missing `User-Agent` is answered with a 403
 * `cf-mitigated: challenge` HTML page rather than data. The sibling Virtuals
 * client already sets both.
 */
const REQUEST_HEADERS = {
  "User-Agent": "Vex-Agent/1.0 (+https://vexlabs.ai)",
  Accept: "application/json",
} as const;

/**
 * Per-call bounds on THIS CALLER'S WAIT. OPTIONAL everywhere, so a caller that
 * omits them behaves exactly as it did before this existed.
 *
 * ## They bound the wait, NOT the request, and that distinction is load-bearing
 *
 * The throttle dedupes by URL: two callers asking for the same token in the same
 * moment SHARE one in-flight request. If a caller's `timeoutMs`/`signal` were
 * handed to that shared fetch, they would leak sideways:
 *
 *   - the price poller's 5 s deadline would silently become an agent call's
 *     deadline, failing a request the agent had 30 s of patience for;
 *   - a poller attaching to an already-running 30 s request would inherit ITS
 *     deadline, so shutdown would wait rather than abort;
 *   - the poller's shutdown abort would cancel the agent's request outright.
 *
 * So the shared request always runs under the DEFAULT policy, and these options
 * only decide how long this caller waits for it and when it walks away. A caller
 * that walks away leaves the shared request running for whoever else wants it.
 */
export interface DexScreenerRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface DexScreenerObservation {
  /** When the provider generated the payload: local fetch time minus the upstream Age, when known. */
  readonly providerFetchedAtMs: number;
  /** Whether THIS client served the value from its own URL cache. */
  readonly cacheHit: boolean;
  /**
   * Age of the value in THIS client's cache only. The upstream CDN's age is
   * `upstreamAgeMs`; summing the two is the reader's call, never pre-added here
   * - a pre-summed value next to `upstreamAgeMs` double-counts staleness.
   */
  readonly cacheAgeMs: number;
  readonly upstreamAgeMs: number | null;
  readonly upstreamAgeKnown: boolean;
}

interface DexScreenerValidatedResponse<T> {
  readonly value: T;
  readonly upstreamAgeMs: number | null;
}

/** Parse the RFC Age response header without treating malformed values as fresh. */
function parseUpstreamAgeMs(response: Response): number | null {
  const raw = response.headers?.get?.("age");
  if (raw === null || raw === undefined || !/^\d+$/.test(raw.trim())) return null;
  const seconds = Number(raw);
  return Number.isSafeInteger(seconds) ? seconds * 1_000 : null;
}

/** Whether these options ask for anything at all. A guard, so no `!` is needed. */
function boundsTheWait(
  options?: DexScreenerRequestOptions,
): options is DexScreenerRequestOptions {
  return options !== undefined
    && (options.timeoutMs !== undefined || options.signal !== undefined);
}

/**
 * Wait for `shared`, giving up on the caller's own deadline or abort.
 *
 * Giving up NEVER touches `shared`; the rejection handler below only stops Node
 * reporting an unhandled rejection for a promise this caller stopped watching.
 * A deadline breach is reported as `HTTP_TIMEOUT` exactly as `fetchWithTimeout`
 * would have, and a caller abort propagates as the signal's own reason, so "the
 * operator stopped" is never rendered as "the provider hung".
 */
async function awaitWithinCallerBounds<T>(
  shared: Promise<T>,
  options: DexScreenerRequestOptions,
): Promise<T> {
  shared.catch(() => undefined);

  const abandon = new AbortController();
  const reasons: Promise<never>[] = [];

  if (options.timeoutMs !== undefined) {
    const timeoutMs = options.timeoutMs;
    reasons.push(new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new VexError(
          ErrorCodes.HTTP_TIMEOUT,
          `Request timed out after ${timeoutMs}ms`,
          "Check network connectivity or try again later",
        ));
      }, timeoutMs);
      abandon.signal.addEventListener("abort", () => clearTimeout(timer));
    }));
  }

  if (options.signal !== undefined) {
    const callerSignal = options.signal;
    reasons.push(new Promise<never>((_resolve, reject) => {
      if (callerSignal.aborted) {
        reject(callerSignal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () =>
        reject(callerSignal.reason ?? new DOMException("Aborted", "AbortError"));
      callerSignal.addEventListener("abort", onAbort, { once: true });
      abandon.signal.addEventListener("abort", () =>
        callerSignal.removeEventListener("abort", onAbort));
    }));
  }

  try {
    return await Promise.race([shared, ...reasons]);
  } finally {
    // Release the timer and the abort listener whatever the outcome.
    abandon.abort();
  }
}

export class DexScreenerClient {
  private readonly throttle: DexScreenerThrottle;
  private readonly observations = new WeakMap<object, DexScreenerObservation>();

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
    options?: DexScreenerRequestOptions,
  ): Promise<T> {
    const url = this.buildUrl(path, query);
    const rateClass = classifyRateClass(path);
    const ttlMs = cacheTtlForClass(rateClass);
    // The normalized request URL (path + ordered query) is the cache/dedupe key.
    try {
      // The shared request carries NO caller policy - see the options doc.
      const shared = this.throttle.runObserved(url, rateClass, ttlMs, async () => {
        const response = await fetchWithTimeout(url, { headers: REQUEST_HEADERS });

        if (!response.ok) {
          if (response.status === 429) {
            // Optional chaining guards test doubles that omit `headers`.
            const retryMs = parseRetryAfterMs(response.headers?.get?.("retry-after"));
            this.throttle.penalize(rateClass, retryMs);
          }
          // The body goes to the mapper in WHATEVER shape it arrived: the live
          // 400 is a JSON *string* (an HTML page), and the old object-with-
          // `error` test discarded it, leaving the agent a bare status.
          throw mapDexScreenerError(response.status, await readJson(response));
        }

        const raw = await readJson(response);
        return {
          value: validator(raw),
          upstreamAgeMs: parseUpstreamAgeMs(response),
        } satisfies DexScreenerValidatedResponse<T>;
      });
      const observed: DexScreenerObserved<DexScreenerValidatedResponse<T>> = await (
        boundsTheWait(options)
        ? awaitWithinCallerBounds(shared, options)
        : shared
      );
      const value = observed.value.value;
      const upstreamAgeMs = observed.value.upstreamAgeMs;
      if (typeof value === "object" && value !== null) {
        this.observations.set(value, {
          providerFetchedAtMs: Math.max(0, observed.fetchedAtMs - (upstreamAgeMs ?? 0)),
          cacheHit: observed.cacheHit,
          cacheAgeMs: observed.cacheAgeMs,
          upstreamAgeMs,
          upstreamAgeKnown: upstreamAgeMs !== null,
        });
      }
      return value;
    } catch (err) {
      mapTransportError(err);
    }
  }

  /** Metadata for a value returned by this client; `null` for test doubles. */
  observationFor(value: unknown): DexScreenerObservation | null {
    return typeof value === "object" && value !== null
      ? this.observations.get(value) ?? null
      : null;
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
  getTokenPairs(
    chainId: string,
    tokenAddress: string,
    options?: DexScreenerRequestOptions,
  ): Promise<TokensPairsResponse> {
    return this.request(
      `/token-pairs/v1/${encodeURIComponent(chainId)}/${encodeURIComponent(tokenAddress)}`,
      validateTokensPairsResponse,
      undefined,
      options,
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
