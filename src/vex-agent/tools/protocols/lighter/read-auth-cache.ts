import type { LighterEnvironment } from "@tools/lighter/constants.js";

/**
 * SWITCH `LIGHTER_READ_AUTH_CACHE` (default OFF).
 *
 * ON lets an approved create order start its duplicate-evidence reads
 * (active orders, inactive orders, trades) in the FIRST parallel batch, with a
 * READ-ONLY account auth token an earlier order on the same scope already
 * proved against Lighter, instead of waiting for the trading key load and a
 * fresh signer mint. OFF never reads or writes this cache, which is today's
 * path exactly.
 *
 * WHAT IS CACHED: the account auth token string, the public key the token was
 * minted for, and two timestamps. Nothing here can sign a transaction or reach
 * `sendTx`: the token authorizes authenticated account reads only, and the
 * trading key it was derived from is never held. The cache lives in process
 * memory, is never persisted, and is never logged.
 *
 * Every order still loads the trading key and mints a fresh token whose public
 * key must match the provider's registered key before any nonce is reserved;
 * the cache only moves a read earlier, it never stands in for that proof.
 */
export const LIGHTER_READ_AUTH_CACHE = false;

/** How long a proven token is reused after it was stored. */
export const LIGHTER_READ_AUTH_CACHE_TTL_MS = 4 * 60 * 1_000;

/**
 * A token is never handed out with less than this left before its own signed
 * deadline. The order path mints with a ten-minute deadline, so a token taken
 * at the end of its TTL still has six minutes left, well past any pre-send read.
 */
export const LIGHTER_READ_AUTH_CACHE_MIN_REMAINING_MS = 5 * 60 * 1_000;

export interface LighterReadAuthCacheScope {
  readonly environment: LighterEnvironment;
  readonly accountIndex: number;
  readonly apiKeyIndex: number;
}

export interface LighterReadAuthCacheEntry {
  readonly token: string;
  /** Normalized (no 0x, lower case) key the token was minted and proven for. */
  readonly publicKey: string;
  readonly storedAtMs: number;
  readonly deadlineMs: number;
}

export function normalizeLighterPublicKey(value: string): string {
  return value.trim().replace(/^0x/i, "").toLowerCase();
}

function scopeKey(scope: LighterReadAuthCacheScope): string {
  return `${scope.environment}:${scope.accountIndex}:${scope.apiKeyIndex}`;
}

/**
 * At most one entry per (environment, accountIndex, apiKeyIndex). The entry
 * carries the public key, and a reader must compare it with the provider's
 * live registered key before trusting anything read with the token, so the
 * effective key is the full (environment, accountIndex, apiKeyIndex,
 * publicKey) tuple: a rotated key never matches an old entry.
 */
export class LighterReadAuthCache {
  private readonly entries = new Map<string, LighterReadAuthCacheEntry>();

  get(scope: LighterReadAuthCacheScope, nowMs: number): LighterReadAuthCacheEntry | null {
    const key = scopeKey(scope);
    const entry = this.entries.get(key);
    if (entry === undefined) return null;
    const usable = nowMs >= entry.storedAtMs
      && nowMs < entry.storedAtMs + LIGHTER_READ_AUTH_CACHE_TTL_MS
      && entry.deadlineMs - nowMs >= LIGHTER_READ_AUTH_CACHE_MIN_REMAINING_MS;
    if (!usable) {
      this.entries.delete(key);
      return null;
    }
    return entry;
  }

  /** Store a token only after Lighter accepted it for an authenticated read. */
  remember(
    scope: LighterReadAuthCacheScope,
    input: { readonly token: string; readonly publicKey: string; readonly deadlineUnixSeconds: number },
    nowMs: number,
  ): void {
    const deadlineMs = input.deadlineUnixSeconds * 1_000;
    if (
      input.token.length === 0
      || !Number.isSafeInteger(input.deadlineUnixSeconds)
      || deadlineMs - nowMs < LIGHTER_READ_AUTH_CACHE_MIN_REMAINING_MS
    ) {
      return;
    }
    this.entries.set(scopeKey(scope), {
      token: input.token,
      publicKey: normalizeLighterPublicKey(input.publicKey),
      storedAtMs: nowMs,
      deadlineMs,
    });
  }

  /**
   * Drop every entry matching the filter; no filter drops everything. Called
   * on any failed read with a cached token, a public-key mismatch, credential
   * save, activation or removal, key registration, and vault lock or unlock.
   */
  invalidate(filter: Partial<LighterReadAuthCacheScope> = {}): void {
    for (const key of [...this.entries.keys()]) {
      const [environment, accountIndex, apiKeyIndex] = key.split(":");
      if (filter.environment !== undefined && filter.environment !== environment) continue;
      if (filter.accountIndex !== undefined && String(filter.accountIndex) !== accountIndex) continue;
      if (filter.apiKeyIndex !== undefined && String(filter.apiKeyIndex) !== apiKeyIndex) continue;
      this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The one process-wide cache the production order path uses when ON. */
export const lighterReadAuthCache = new LighterReadAuthCache();

export function invalidateLighterReadAuthCache(filter: Partial<LighterReadAuthCacheScope> = {}): void {
  lighterReadAuthCache.invalidate(filter);
}
