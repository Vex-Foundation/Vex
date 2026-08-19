/**
 * DexScreener client-side throttle + cache (PER-PROCESS only).
 *
 * Wraps every `DexScreenerClient.request()` so the whole app — the agent
 * handlers today, the Electron main market service later — shares one budget
 * transparently. There is NO cross-process coordination: each Node process gets
 * its own buckets and cache.
 *
 * Four concerns, one seam:
 *  - Token bucket per rate class. DexScreener publishes 300 req/min for
 *    search/pairs/tokens/token-pairs ("fast") and 60 req/min for everything
 *    else ("slow"). Each class has its own bucket; `acquire()` waits for a
 *    token before the fetch is allowed to fire.
 *  - TTL cache keyed by the normalized request URL. Fast endpoints cache ~8 s
 *    (prices move); slow endpoints (profiles/boosts/metas/CTO/ads/orders) cache
 *    ~60 s. Bounded size with insertion-order (oldest-first) eviction.
 *  - In-flight dedupe: concurrent identical requests share one promise, so a
 *    burst of duplicate lookups costs a single fetch + a single token.
 *  - `Retry-After` honoring: on a 429 the caller reports the delay via
 *    `penalize()`, which parks the whole rate class until it elapses.
 *
 * The clock and sleep are injectable so the unit tests can drive TTL/backoff
 * deterministically without real timers.
 */

export type DexRateClass = "fast" | "slow";

/** Documented DexScreener per-minute allowances, used as bucket capacity + refill. */
const RATE_PER_MINUTE: Record<DexRateClass, number> = {
  fast: 300,
  slow: 60,
};

/**
 * How long a cached response for each class stays fresh.
 *
 * `fast` matches the provider's OWN edge policy — it answers
 * `cache-control: public, max-age=30` — rather than guessing under it. An 8 s
 * local TTL could never be fresher than 30 s-stale edge data; it only bought
 * ~4x the calls against the 300 rpm budget for identical bytes (SPEC §2.5 W2f).
 */
const TTL_MS: Record<DexRateClass, number> = {
  fast: 30_000, // provider edge cache is 30 s — a shorter local TTL buys nothing
  slow: 60_000, // profiles/boosts/metas/CTO/ads/orders — slow-moving feeds
};

const DEFAULT_MAX_CACHE_ENTRIES = 256;

/** "fast" (300/min) for the price/pair/token endpoints, "slow" (60/min) otherwise. */
export function classifyRateClass(path: string): DexRateClass {
  if (
    path.startsWith("/latest/dex/search") ||
    path.startsWith("/latest/dex/pairs/") ||
    path.startsWith("/tokens/v1/") ||
    path.startsWith("/token-pairs/v1/")
  ) {
    return "fast";
  }
  return "slow";
}

export function cacheTtlForClass(rateClass: DexRateClass): number {
  return TTL_MS[rateClass];
}

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
  fetchedAtMs: number;
  expiresAt: number;
}

export interface DexScreenerObserved<T> {
  readonly value: T;
  readonly fetchedAtMs: number;
  readonly cacheHit: boolean;
  readonly cacheAgeMs: number;
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

export class DexScreenerThrottle {
  private readonly buckets: Record<DexRateClass, TokenBucket>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<DexScreenerObserved<unknown>>>();
  private readonly deps: ThrottleDeps;
  private readonly maxCacheEntries: number;

  constructor(
    options: { maxCacheEntries?: number; deps?: Partial<ThrottleDeps> } = {},
  ) {
    this.deps = { ...REAL_DEPS, ...options.deps };
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.buckets = {
      fast: new TokenBucket(RATE_PER_MINUTE.fast, RATE_PER_MINUTE.fast, this.deps),
      slow: new TokenBucket(RATE_PER_MINUTE.slow, RATE_PER_MINUTE.slow, this.deps),
    };
  }

  /**
   * Run `fetcher` through cache → dedupe → rate limit. A fresh cache hit skips
   * the network entirely; an identical in-flight request is shared; otherwise a
   * rate-limit token is acquired before the fetch fires and the result is
   * cached. Errors are neither cached nor left in the in-flight map.
   */
  async run<T>(
    key: string,
    rateClass: DexRateClass,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    return (await this.runObserved(key, rateClass, ttlMs, fetcher)).value;
  }

  /** The same request path, with truthful cache/fetch provenance. */
  async runObserved<T>(
    key: string,
    rateClass: DexRateClass,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<DexScreenerObserved<T>> {
    const now = this.deps.now();
    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > now) {
      return {
        value: cached.value as T,
        fetchedAtMs: cached.fetchedAtMs,
        cacheHit: true,
        cacheAgeMs: Math.max(0, now - cached.fetchedAtMs),
      };
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<DexScreenerObserved<T>>;
    }

    const promise = (async () => {
      await this.buckets[rateClass].acquire();
      const value = await fetcher();
      const fetchedAtMs = this.deps.now();
      this.setCache(key, value, fetchedAtMs, ttlMs);
      return { value, fetchedAtMs, cacheHit: false, cacheAgeMs: 0 };
    })();

    this.inFlight.set(key, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(key);
    }
  }

  /** Report an upstream 429 for a rate class so the next requests back off. */
  penalize(rateClass: DexRateClass, retryAfterMs: number): void {
    this.buckets[rateClass].penalize(retryAfterMs);
  }

  private setCache(key: string, value: unknown, fetchedAtMs: number, ttlMs: number): void {
    // Refresh insertion order so a re-cached key is treated as newest.
    this.cache.delete(key);
    this.cache.set(key, { value, fetchedAtMs, expiresAt: fetchedAtMs + ttlMs });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
