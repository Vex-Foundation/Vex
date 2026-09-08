import {
  LIGHTER_CACHE_TTL_MS,
  LIGHTER_PUBLIC_REST_RATE_PER_MINUTE,
  type LighterEnvironment,
} from "./constants.js";
import { ErrorCodes, VexError } from "../../errors.js";
import { delay, throwIfAborted } from "../../utils/cancellation.js";

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

/**
 * One shared, in-flight provider read. `waiters` counts the callers still
 * interested in the answer; the request is cancelled only when that reaches
 * zero.
 */
interface InFlightEntry {
  promise: Promise<unknown>;
  readonly controller: AbortController;
  waiters: number;
}

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

interface ThrottleDeps {
  now: () => number;
  /**
   * Rate-limit wait. Rejects with the signal's own reason when the caller
   * abandons the request, so a queued call never keeps burning its slot after
   * the reader has gone.
   */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

const REAL_DEPS: ThrottleDeps = {
  now: () => Date.now(),
  sleep: (ms, signal) => delay(Math.max(0, ms), signal),
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

  async acquire(signal?: AbortSignal): Promise<void> {
    for (;;) {
      throwIfAborted(signal);
      const now = this.deps.now();
      if (now < this.penaltyUntil) {
        await this.deps.sleep(this.penaltyUntil - now, signal);
        continue;
      }
      this.refill(now);
      if (this.tokens >= 1) {
        // A token is only spent by a caller that is still waiting for the
        // answer: the abort check above and the one the queue performs before
        // the fetch keep an abandoned request from consuming provider budget.
        this.tokens -= 1;
        return;
      }
      const waitMs = Math.ceil((1 - this.tokens) / this.refillPerMs);
      await this.deps.sleep(waitMs, signal);
    }
  }

  penalize(retryAfterMs: number): void {
    this.penaltyUntil = Math.max(this.penaltyUntil, this.deps.now() + Math.max(0, retryAfterMs));
  }
}

export class LighterThrottle {
  private readonly buckets: Record<LighterEnvironment, TokenBucket>;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, InFlightEntry>();
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

  /**
   * Rate-limited, cached, single-flight read.
   *
   * CANCELLATION AND COALESCING, because the two interact and the policy has
   * to be stated once. `signal` belongs to ONE caller, while an in-flight
   * entry may be shared by several. Aborting therefore abandons the caller's
   * WAIT immediately (it rejects with the signal's own reason) and only
   * cancels the underlying request when the abandoning caller was the last
   * one still interested. A second reader waiting on the same key keeps its
   * answer, and the cache it populates stays correct. The fetcher receives the
   * ENTRY's signal, never a single caller's, for exactly that reason.
   *
   * An already-aborted caller never takes a rate-limit token and never starts
   * a request.
   */
  async run<T>(
    key: string,
    bucketKey: LighterEnvironment,
    ttlMs: number,
    fetcher: (signal?: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    throwIfAborted(signal);
    if (ttlMs <= 0) {
      // Uncached reads have exactly one caller, so the caller's own signal is
      // the request's signal: no sharing to reason about.
      await this.bucketFor(bucketKey).acquire(signal);
      throwIfAborted(signal);
      return fetcher(signal);
    }

    const cached = this.cache.get(key);
    if (cached && cached.expiresAt > this.deps.now()) {
      return cached.value as T;
    }

    const existing = this.inFlight.get(key);
    // An entry whose last waiter has already left is cancelled and will only
    // ever reject. A new caller starts its own read rather than inheriting
    // someone else's abandonment; the stale entry retires itself.
    if (existing !== undefined && !existing.controller.signal.aborted) {
      existing.waiters += 1;
      return await this.joinInFlight<T>(existing, signal);
    }

    const controller = new AbortController();
    const entry: InFlightEntry = {
      promise: Promise.resolve<unknown>(undefined),
      controller,
      waiters: 1,
    };
    entry.promise = (async () => {
      await this.bucketFor(bucketKey).acquire(controller.signal);
      throwIfAborted(controller.signal);
      const value = freezeCachedValue(await fetcher(controller.signal));
      this.setCache(key, value, ttlMs);
      return value;
    })();
    // Retire the entry on every terminal path, and observe the rejection here
    // so an entry every caller abandoned can never raise an unhandled
    // rejection. Real waiters re-observe the same promise in `joinInFlight`.
    const retire = (): void => {
      if (this.inFlight.get(key) === entry) this.inFlight.delete(key);
    };
    entry.promise.then(retire, retire);

    this.inFlight.set(key, entry);
    return await this.joinInFlight<T>(entry, signal);
  }

  /** Await a shared entry, abandoning it (not cancelling it) on caller abort. */
  private async joinInFlight<T>(entry: InFlightEntry, signal?: AbortSignal): Promise<T> {
    if (signal === undefined) return await (entry.promise as Promise<T>);
    if (signal.aborted) {
      this.abandonInFlight(entry);
      throwIfAborted(signal);
    }
    return await new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        this.abandonInFlight(entry);
        reject(signal.reason);
      };
      // Removes the listener on the non-abort exits; `once` covers the abort.
      const settled = (): void => signal.removeEventListener("abort", onAbort);
      signal.addEventListener("abort", onAbort, { once: true });
      entry.promise.then(
        (value) => {
          settled();
          resolve(value as T);
        },
        (cause: unknown) => {
          settled();
          reject(cause);
        },
      );
    });
  }

  /** Drop one waiter; the last one leaving cancels the shared request. */
  private abandonInFlight(entry: InFlightEntry): void {
    entry.waiters -= 1;
    if (entry.waiters <= 0) entry.controller.abort();
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
