/**
 * Morpho request budget, circuit breaker, and short-TTL cache (PER-PROCESS).
 *
 * This module exists because of one asymmetric risk. Morpho's keyless GraphQL
 * API allows roughly 750 requests per minute, but sustained abuse (documented
 * around 20,000 requests an hour) is answered with `Retry-After: 604800` - a
 * SEVEN-DAY block of the caller. Every other provider in this tree punishes
 * over-use with a minute of backoff; this one can take the integration offline
 * for a week, on a client that needs no key and therefore has no per-user quota
 * to isolate the damage. The budget is not a nicety here, and it is wired from
 * the first request rather than added after an incident.
 *
 * Three defences, deliberately layered:
 *
 *  1. BUDGET - a token bucket well under the published ceiling. Slowing down is
 *     always cheaper than a week of silence.
 *  2. CIRCUIT BREAKER - a long `Retry-After`, or repeated 429s, OPENS the
 *     breaker. While open, no request leaves the process at all and callers get
 *     `MORPHO_BUDGET_EXHAUSTED` naming when it closes. Backing off inside our
 *     own process cannot dig the hole deeper.
 *  3. TTL CACHE + in-flight dedupe - Morpho caches 2-5 seconds on its own side,
 *     so a short local TTL removes the repeated identical reads an agent loop
 *     produces without ever showing staler data than the provider would.
 *
 * The breaker's state is EXPOSED (`describeState`) so the client can put it in
 * an error. A refusal that does not say we are the ones refusing, and until
 * when, is the silent fail-soft rules/90 forbids.
 *
 * Clock and sleep are injectable so tests drive the arithmetic without timers.
 */

import { VexError, ErrorCodes } from "../../errors.js";

/**
 * Conservative ceiling. Morpho publishes ~750/min; a read lane driven by an
 * agent has no business anywhere near that, and the gap is the safety margin
 * against a second Vex process on the same egress IP.
 */
export const MORPHO_REQUESTS_PER_MINUTE = 60;

/** A `Retry-After` at or above this is treated as a ban, not a backoff. */
const BAN_THRESHOLD_SECONDS = 3_600;

/** Consecutive 429s that trip the breaker even without a long `Retry-After`. */
const CONSECUTIVE_429_TRIP = 3;

/** Breaker hold when Morpho named no interval. */
const DEFAULT_TRIP_MS = 60_000;

const DEFAULT_MAX_CACHE_ENTRIES = 64;

/** Morpho caches 2-5s upstream; matching it locally cannot serve staler data. */
export const MORPHO_TTL = {
  markets: 5_000,
  market: 5_000,
  /**
   * Vault reads get a LONGER TTL than market reads, and the reason is what the
   * two calls cost rather than a guess about volatility.
   *
   * A vault screening call at `version: both` is TWO upstream requests, and the
   * V2 list document measured 317,750 complexity at 50 rows on 2026-08-14
   * against a market list's 23,750 - roughly thirteen times the server work per
   * call. A vault's headline numbers also move on the same block cadence as the
   * markets underneath it, so 15 seconds cannot mislead an agent in a way 5
   * seconds would not: a rate that changed inside that window was already stale
   * by the time it was rendered. The cheap defence against the seven-day ban is
   * to not send the expensive query three times in one turn.
   */
  vaults: 15_000,
  vault: 15_000,
  /**
   * Positions get the SHORT market TTL, not the longer vault one.
   *
   * A position's health factor moves with every block that moves the collateral
   * price, and a live row on 2026-08-14 sat at 1.0004 - inside that reading, the
   * difference between "fine" and "already liquidatable" is smaller than the
   * cache window would be if it matched the vault reads. A stale rate misprices
   * a decision; a stale health factor tells a user their position is safe while
   * it is being taken.
   */
  positions: 5_000,
  /**
   * Transactions are APPEND-ONLY. A row that has been mined cannot change, so
   * the only thing a longer window can hide is the newest few rows of a history
   * that is already ordered newest-first and reports its own total. Thirty
   * seconds is the cheapest defence available against the seven-day ban for a
   * read an agent naturally repeats while paging.
   */
  activity: 30_000,
  chains: 3_600_000,
} as const;

interface BudgetDeps {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

const REAL_DEPS: BudgetDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms))),
};

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface MorphoBudgetState {
  open: boolean;
  /** Epoch ms the breaker closes at, when open. */
  opensAt: number | null;
  reason: string | null;
}

export class MorphoBudget {
  private tokens: number;
  private lastRefill: number;
  private breakerUntil = 0;
  private breakerReason: string | null = null;
  private consecutiveRateLimits = 0;
  private readonly refillPerMs: number;
  private readonly capacity: number;
  private readonly deps: BudgetDeps;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly maxCacheEntries: number;

  constructor(
    options: { requestsPerMinute?: number; maxCacheEntries?: number; deps?: Partial<BudgetDeps> } = {},
  ) {
    this.deps = { ...REAL_DEPS, ...options.deps };
    this.capacity = options.requestsPerMinute ?? MORPHO_REQUESTS_PER_MINUTE;
    this.refillPerMs = this.capacity / 60_000;
    this.tokens = this.capacity;
    this.lastRefill = this.deps.now();
    this.maxCacheEntries = options.maxCacheEntries ?? DEFAULT_MAX_CACHE_ENTRIES;
  }

  /** Current breaker state, for an error message or a health read. */
  describeState(): MorphoBudgetState {
    const now = this.deps.now();
    if (now >= this.breakerUntil) return { open: false, opensAt: null, reason: null };
    return { open: true, opensAt: this.breakerUntil, reason: this.breakerReason };
  }

  /**
   * Run `fetcher` through cache -> in-flight dedupe -> breaker -> budget.
   *
   * The breaker is checked INSIDE the gated section rather than before the
   * cache, so a cached answer still serves while Morpho has us blocked. Serving
   * data we already hold is not a request.
   */
  async run<T>(key: string, ttlMs: number, fetcher: () => Promise<T>): Promise<T> {
    if (ttlMs > 0) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > this.deps.now()) return cached.value as T;
    }

    const existing = this.inFlight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = (async () => {
      this.assertBreakerClosed();
      await this.acquire();
      const value = await fetcher();
      // A successful response is the only thing that clears the 429 streak.
      this.consecutiveRateLimits = 0;
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

  /**
   * Record a rate-limited response. A ban-length `Retry-After` trips the breaker
   * for exactly the interval Morpho named - never for a locally invented one
   * (rules/06: read what the provider tells you about limits).
   */
  recordRateLimit(retryAfterSeconds: number | undefined): void {
    this.consecutiveRateLimits += 1;
    if (retryAfterSeconds !== undefined && retryAfterSeconds >= BAN_THRESHOLD_SECONDS) {
      this.trip(
        retryAfterSeconds * 1_000,
        `Morpho answered with Retry-After ${retryAfterSeconds}s, which is its abuse block rather than a backoff.`,
      );
      return;
    }
    if (retryAfterSeconds !== undefined) {
      this.trip(retryAfterSeconds * 1_000, `Morpho asked for a ${retryAfterSeconds}s pause.`);
      return;
    }
    if (this.consecutiveRateLimits >= CONSECUTIVE_429_TRIP) {
      this.trip(
        DEFAULT_TRIP_MS,
        `${this.consecutiveRateLimits} consecutive Morpho rate limits with no Retry-After header.`,
      );
    }
  }

  private trip(holdMs: number, reason: string): void {
    const until = this.deps.now() + Math.max(0, holdMs);
    if (until <= this.breakerUntil) return;
    this.breakerUntil = until;
    this.breakerReason = reason;
  }

  private assertBreakerClosed(): void {
    const state = this.describeState();
    if (!state.open || state.opensAt === null) return;
    const waitSeconds = Math.ceil((state.opensAt - this.deps.now()) / 1_000);
    throw new VexError(
      ErrorCodes.MORPHO_BUDGET_EXHAUSTED,
      `Vex is holding Morpho requests for another ${describeWait(waitSeconds)}. ${state.reason ?? ""}`.trim(),
      "This is Vex's own circuit breaker, not a Morpho refusal - no request was sent. "
      + "Morpho blocks abusive callers for a week, so the breaker will not be bypassed. Use another source until it closes.",
    );
  }

  /** Resolve once a token is available. Waiting is always cheaper than a ban. */
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

function describeWait(seconds: number): string {
  if (seconds >= 86_400) return `${Math.ceil(seconds / 86_400)} day(s)`;
  if (seconds >= 3_600) return `${Math.ceil(seconds / 3_600)} hour(s)`;
  return `${Math.max(seconds, 1)} second(s)`;
}
