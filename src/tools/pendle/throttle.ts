/**
 * Pendle API client-side throttle + cache (PER-PROCESS only).
 *
 * The hosted Pendle API meters by COMPUTE UNITS (CU), not request count: a
 * convert call costs ~7 CU (5 base + 1 per aggregator), reads cost ~1 CU. The
 * public budget is 100 CU/min/IP; we self-throttle conservatively under that.
 *
 * Mirrors the virtuals/dexscreener throttles with ONE difference: the bucket is
 * CU-WEIGHTED — `run(key, cost, ttlMs, fetcher)` acquires `cost` tokens. Plus:
 *  - TTL cache keyed by the normalized request (markets 60s, assets 300s,
 *    prices 15s; convert is NEVER cached — pass ttlMs = 0),
 *  - in-flight dedupe: concurrent identical requests share one promise,
 *  - `Retry-After` honoring: a 429 parks the bucket via `penalize()`.
 *
 * The clock + sleep are injectable so unit tests drive CU math / backoff without
 * real timers.
 */

/** Conservative CU budget per minute (public limit is 100 CU/min/IP). */
const CU_PER_MINUTE = 90;

/** Per-endpoint TTLs. Convert is never cached (pass 0). */
export const PENDLE_TTL = {
  markets: 60_000,
  assets: 300_000,
  prices: 15_000,
  positions: 30_000,
  /** Supported aggregators change rarely — cache aggressively (1h). */
  aggregators: 3_600_000,
  convert: 0,
  /** Claim builds a fresh mutating tx — NEVER cached. */
  claim: 0,
} as const;

/** Per-endpoint compute-unit cost estimates. */
export const PENDLE_CU = {
  markets: 1,
  assets: 1,
  prices: 1,
  /** Live `x-computing-unit` header on the dashboard read is 4, not the 3 we assumed. */
  positions: 4,
  aggregators: 1,
  /** 5 base + 1 per allowed aggregator (kyberswap, okx). */
  convert: 7,
  /** Claim (redeem-interests-and-rewards) — x-computing-unit 5 per the spec. */
  claim: 5,
} as const;

const DEFAULT_MAX_CACHE_ENTRIES = 64;

/** Parse a `Retry-After` header (delta-seconds or HTTP-date) into ms. */
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

/** CU-weighted token bucket: continuous refill toward capacity, plus a penalty gate. */
class CuBucket {
  private tokens: number;
  private lastRefill: number;
  private penaltyUntil = 0;
  private readonly refillPerMs: number;

  constructor(
    private readonly capacity: number,
    cuPerMinute: number,
    private readonly deps: ThrottleDeps,
  ) {
    this.tokens = capacity;
    this.lastRefill = deps.now();
    this.refillPerMs = cuPerMinute / 60_000;
  }

  private refill(now: number): void {
    const elapsed = now - this.lastRefill;
    if (elapsed <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
    this.lastRefill = now;
  }

  /** Resolve once `cost` CU are available AND no penalty is in force. */
  async acquire(cost: number): Promise<void> {
    // A single request can never cost more than the whole bucket; clamp so a
    // mis-estimate can still eventually acquire.
    const need = Math.min(Math.max(cost, 1), this.capacity);
    for (;;) {
      const now = this.deps.now();
      if (now < this.penaltyUntil) {
        await this.deps.sleep(this.penaltyUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= need) {
        this.tokens -= need;
        return;
      }
      const waitMs = Math.ceil((need - this.tokens) / this.refillPerMs);
      await this.deps.sleep(waitMs);
    }
  }

  penalize(retryAfterMs: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.deps.now() + Math.max(0, retryAfterMs));
  }
}

export class PendleThrottle {
  private readonly bucket: CuBucket;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly deps: ThrottleDeps;
  private readonly maxCacheEntries: number;

  constructor(
    options: { maxCacheEntries?: number; cuPerMinute?: number; deps?: Partial<ThrottleDeps> } = {},
  ) {
    this.deps = { ...REAL_DEPS, ...options.deps };
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    const cuPerMinute = options.cuPerMinute ?? CU_PER_MINUTE;
    this.bucket = new CuBucket(cuPerMinute, cuPerMinute, this.deps);
  }

  /**
   * Run `fetcher` through cache → dedupe → CU rate limit. A fresh cache hit skips
   * the network entirely; an identical in-flight request is shared; otherwise
   * `cost` CU are acquired before the fetch fires. `ttlMs = 0` disables caching
   * (convert). Errors are neither cached nor left in the in-flight map.
   */
  async run<T>(key: string, cost: number, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.deps.now()) {
        return cached.value as T;
      }
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      await this.bucket.acquire(cost);
      const value = await fetcher();
      if (ttlMs > 0) this.setCache(key, value, ttlMs);
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
    this.cache.delete(key);
    this.cache.set(key, { value, expiresAt: this.deps.now() + ttlMs });
    while (this.cache.size > this.maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}
