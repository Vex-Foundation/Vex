/**
 * Merkl request budget and short-TTL cache (PER-PROCESS).
 *
 * DELIBERATELY SIMPLER THAN `src/tools/morpho/budget.ts`, and the difference is
 * a measured one rather than an oversight. Morpho's keyless GraphQL answers
 * sustained abuse with `Retry-After: 604800` - a seven-day block - which is why
 * that lane carries a circuit breaker that latches. Merkl publishes its limit on
 * every single response (`x-ratelimit-limit: 4200, 4200;w=60`, live-observed
 * 2026-08-14) together with the remaining count, has no documented ban, and sits
 * two orders of magnitude above what an agent read consumes. Building a latching
 * breaker for it would be error handling for a scenario the system cannot reach,
 * which rules/01 names as complexity rather than safety.
 *
 * What IS needed, and is here:
 *
 *  1. A TOKEN BUCKET well under the published ceiling, so an agent loop cannot
 *     turn one user question into an unbounded burst against a shared keyless
 *     endpoint.
 *  2. A TTL CACHE plus in-flight dedupe. Merkl serves `cache-control:
 *     public, max-age=60`, so a local window of the same size can never show
 *     staler data than Merkl's own edge would have served, and it removes the
 *     repeated identical reads a multi-chain answer produces.
 *
 * Clock and sleep are injectable so tests drive the arithmetic without timers.
 */

import { MERKL_REQUESTS_PER_MINUTE } from "./constants.js";

interface BudgetDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_DEPS: BudgetDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

const DEFAULT_MAX_CACHE_ENTRIES = 128;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export class MerklBudget {
  private tokens: number;
  private lastRefill: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;
  private readonly deps: BudgetDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly maxCacheEntries: number;

  constructor(
    options: { requestsPerMinute?: number; maxCacheEntries?: number; deps?: Partial<BudgetDeps> } = {},
  ) {
    this.deps = { ...REAL_DEPS, ...options.deps };
    this.capacity = options.requestsPerMinute ?? MERKL_REQUESTS_PER_MINUTE;
    this.refillPerMs = this.capacity / 60_000;
    this.tokens = this.capacity;
    this.lastRefill = this.deps.now();
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  /** Run `fetcher` through cache -> in-flight dedupe -> budget. */
  async run<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.deps.now()) return cached.value as T;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      await this.acquire();
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

  /** Resolve once a token is available. Waiting is cheaper than being throttled. */
  private async acquire(): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      const elapsed = now - this.lastRefill;
      if (elapsed > 0) {
        this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerMs);
        this.lastRefill = now;
      }
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await this.deps.sleep(Math.ceil((1 - this.tokens) / this.refillPerMs));
    }
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
