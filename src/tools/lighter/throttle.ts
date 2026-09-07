import {
  LIGHTER_CACHE_TTL_MS,
  LIGHTER_PUBLIC_REST_RATE_PER_MINUTE,
  type LighterEnvironment,
} from "./constants.js";
import { ErrorCodes, VexError } from "../../errors.js";

const DEFAULT_MAX_CACHE_ENTRIES = 128;

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

  async acquire(): Promise<void> {
    for (;;) {
      const now = this.deps.now();
      if (now < this.penaltyUntil) {
        await this.deps.sleep(this.penaltyUntil - now);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await this.deps.sleep(waitMs);
    }
  }

  penalize(retryAfterMs: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.deps.now() + Math.max(0, retryAfterMs));
  }
}

export class LighterThrottle {
  private readonly buckets: Record<LighterEnvironment, TokenBucket>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly deps: ThrottleDeps;
  private readonly maxCacheEntries: number;
  private readonly ttlMs: number;

  constructor(
    options: { maxCacheEntries?: number; ttlMs?: number; deps?: Partial<ThrottleDeps> } = {},
  ) {
    this.deps = { ...REAL_DEPS, ...options.deps };
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
    this.ttlMs = options.ttlMs ?? LIGHTER_CACHE_TTL_MS;
    this.buckets = {
      core: new TokenBucket(
        LIGHTER_PUBLIC_REST_RATE_PER_MINUTE,
        LIGHTER_PUBLIC_REST_RATE_PER_MINUTE,
        this.deps,
      ),
      rhc: new TokenBucket(
        LIGHTER_PUBLIC_REST_RATE_PER_MINUTE,
        LIGHTER_PUBLIC_REST_RATE_PER_MINUTE,
        this.deps,
      ),
    };
  }

  get defaultTtlMs(): number {
    return this.ttlMs;
  }

  async run<T>(
    key: string,
    bucketKey: LighterEnvironment,
    ttlMs: number,
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (ttlMs <= 0) {
      await this.bucketFor(bucketKey).acquire();
      return fetcher();
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.deps.now()) {
      return cached.value as T;
    }

    const existing = this.inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = (async () => {
      await this.bucketFor(bucketKey).acquire();
      const value = freezeCachedValue(await fetcher());
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

  penalize(bucketKey: LighterEnvironment, retryAfterMs: number): void {
    this.bucketFor(bucketKey).penalize(retryAfterMs);
  }

  private bucketFor(bucketKey: LighterEnvironment): TokenBucket {
    const bucket = this.buckets[bucketKey];
    if (bucket === undefined) {
      throw new VexError(
        ErrorCodes.LIGHTER_INVALID_REQUEST,
        `Invalid Lighter environment: ${String(bucketKey)}`,
        "Use one of: core, rhc.",
      );
    }
    return bucket;
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

function freezeCachedValue<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  const object = value as object;
  if (seen.has(object)) return value;
  seen.add(object);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeCachedValue(child, seen);
  }
  return Object.freeze(value);
}
