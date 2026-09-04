/**
 * Virtuals API client-side throttle + cache (PER-PROCESS only).
 *
 * The Virtuals API (https://api.virtuals.io) is an unauthenticated, undocumented
 * Strapi backend with no published rate limit. This wrapper self-throttles every
 * request conservatively so the whole app (agent handlers today, the own-token
 * banner) shares ONE budget transparently. There is NO cross-process
 * coordination: each Node process gets its own bucket + cache.
 *
 * Mirrors the DexScreener throttle design with a single rate class:
 *  - Token bucket at 60 req/min (conservative — the API is undocumented).
 *  - TTL cache keyed by the normalized request URL (30 s — agent metrics move
 *    slowly and detail/list payloads are large). Bounded size, oldest-first
 *    eviction.
 *  - In-flight dedupe: concurrent identical requests share one promise.
 *  - `Retry-After` honoring: a 429 parks the bucket via `penalize()`.
 *
 * The clock + sleep are injectable so unit tests drive TTL/backoff without real
 * timers.
 */

/**
 * Conservative per-minute allowance for the Strapi API (undocumented - stay
 * well under). Callers that front a DIFFERENT host pass their own
 * `ratePerMinute`: `candles/geckoterminal.ts` measured a 429 after five calls
 * spaced 1.2 s apart, so it runs its own bucket an order of magnitude slower.
 */
const RATE_PER_MINUTE = 60;

/** Cache freshness. Agent metrics move slowly; payloads are large. */
const DEFAULT_TTL_MS = 30_000;

const DEFAULT_MAX_CACHE_ENTRIES = 128;

/**
 * Parse a `Retry-After` header into milliseconds. Supports both the
 * delta-seconds form (`"3"`) and the HTTP-date form. Returns a sane default
 * when the header is absent or unparseable so a 429 always yields a real pause.
 */
export function parseRetryAfterMs(header: string | null | undefined, fallbackMs = 5_000): number {
  if (!header) return fallbackMs;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1_000, 60_000);
  }
  const date = Date.parse(header);
  if (!Number.isNaN(date)) {
    return Math.max(0, Math.min(date - Date.now(), 60_000));
  }
  return fallbackMs;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

interface ThrottleDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_DEPS: ThrottleDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

/** Classic token bucket: continuous refill toward `capacity`, plus a penalty gate. */
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private penaltyUntil = 0;
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    ratePerMinute: number,
    private readonly deps: ThrottleDeps,
  ) {
    this.tokens = capacity;
    this.lastRefill = deps.now();
    this.refillPerMs = ratePerMinute / 60_000;
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Resolve once a token is available AND no active penalty is in force. */
  async acquire(): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      if (now < this.penaltyUntil) {
        await this.deps.sleep(this.penaltyUntil - now);
        continue;
      }
      this.refill(now);
      // Check-and-consume is synchronous (single-threaded), so it never
      // over-issues even under concurrent acquirers.
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await this.deps.sleep(waitMs);
    }
  }

  /** Park this bucket until `now + retryAfterMs` (honors an upstream 429). */
  penalize(retryAfterMs: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.deps.now() + Math.max(0, retryAfterMs));
  }
}

export class VirtualsThrottle {
  private readonly bucket: TokenBucket;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly deps: ThrottleDeps;
  private readonly maxCacheEntries: number;
  private readonly ttlMs: number;

  constructor(
    options: {
      maxCacheEntries?: number;
      ttlMs?: number;
      /** Requests per minute AND bucket capacity. Defaults to the Strapi rate. */
      ratePerMinute?: number;
      deps?: Partial<ThrottleDeps>;
    } = {},
  ) {
    this.deps = { ...REAL_DEPS, ...options.deps };
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const rate = options.ratePerMinute ?? RATE_PER_MINUTE;
    this.bucket = new TokenBucket(rate, rate, this.deps);
  }

  /** Default TTL for a cached response (exposed so the client can pass it in). */
  get defaultTtlMs(): number {
    return this.ttlMs;
  }

  /**
   * Run `fetcher` through cache → dedupe → rate limit. A fresh cache hit skips
   * the network entirely; an identical in-flight request is shared; otherwise a
   * rate-limit token is acquired before the fetch fires and the result is
   * cached. Errors are neither cached nor left in the in-flight map.
   */
  async run<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.deps.now()) {
      return cached.value as T;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      await this.bucket.acquire();
      const value = await fetcher();
      this.setCache(key, value, ttlMs);
      return value;
    })();

    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Report an upstream 429 so the next requests back off. */
  penalize(retryAfterMs: number): void {
    this.bucket.penalize(retryAfterMs);
  }

  private setCache(key: string, value: unknown, ttlMs: number): void {
    // Refresh insertion order so a re-cached key is treated as newest.
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: this.deps.now() + ttlMs });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
