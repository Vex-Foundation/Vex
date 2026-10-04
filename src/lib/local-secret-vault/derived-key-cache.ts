import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import type { LocalSecretVaultOptions } from "./status.js";

/**
 * Process-memory cache of the scrypt-DERIVED vault key, for unlocked-session
 * reads only.
 *
 * What it holds: per vault file, at most ONE derived AES-256 key together with
 * the exact inputs it was derived from (salt, KDF params, and an HMAC-SHA256
 * fingerprint of the password under a random per-process key). It never holds
 * vault contents, a decrypted secret, or the password itself.
 *
 * Why a hit is exactly as good as a derive: the key is a pure function of
 * (password, salt, N, r, p, dkLen), and a hit requires every one of those
 * inputs to match. A different password, salt or parameter set is a miss and
 * derives normally, so a rewritten vault (fresh random salt) can never match
 * an older entry. The GCM tag is still checked on every read; a cached key
 * that fails it is dropped and the read derives once more from scratch.
 *
 * Opt-in per call: the vault functions use it only when a caller passes it in
 * `derivedKeyCache`. Unlocking with a typed password, verifying a password,
 * creating a vault and every other authentication path never pass it and
 * always pay the full KDF.
 *
 * The owner drops everything with `clear()` on lock, unlock and every other
 * session transition. `clear()` zero-fills the cached buffers (best effort: a
 * key the derive itself returned is left to the garbage collector), rotates
 * the fingerprint key, and invalidates operations already in flight so none of
 * them can store a key after the drop. Nothing here is logged, serialised or
 * put into an error; the class keeps its state in private fields.
 */

/** The scrypt parameter set a vault file declares. */
export interface VaultKdfParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly dkLen: number;
}

export type VaultTimingOperation = "read" | "write";

/**
 * One `[vault-timing]` record: numbers, the operation kind and the caller's
 * enum label only. Never a key, a password, a fingerprint or a path.
 */
export interface VaultTimingRecord {
  readonly op: VaultTimingOperation;
  readonly label: string | null;
  readonly cacheHit: number;
  readonly cacheMiss: number;
  readonly tagRetry: number;
  readonly derives: number;
  readonly deriveMs: number;
  readonly lockWaitMs: number;
  readonly totalMs: number;
}

export interface VaultDerivedKeyCacheOptions {
  /** Receives one record per vault operation that ran with this cache. */
  readonly onTiming?: (record: VaultTimingRecord) => void;
}

/**
 * Options for the vault calls that may use the cache. Absent or null
 * `derivedKeyCache` runs exactly the uncached path.
 */
export interface LocalSecretVaultCacheOptions extends LocalSecretVaultOptions {
  readonly derivedKeyCache?: VaultDerivedKeyCache | null;
  /** Enum-style caller label for the timing record; never a secret. */
  readonly timingLabel?: string;
}

interface CacheEntry {
  readonly salt: Buffer;
  readonly params: VaultKdfParams;
  readonly fingerprint: Buffer;
  readonly key: Buffer;
}

function copyKey(source: Buffer): Buffer {
  // A dedicated allocation, not a slice of Node's shared small-buffer pool,
  // so a later zero-fill covers exactly this copy.
  const copy = Buffer.alloc(source.length);
  source.copy(copy);
  return copy;
}

function sameParams(left: VaultKdfParams, right: VaultKdfParams): boolean {
  return left.N === right.N && left.r === right.r && left.p === right.p && left.dkLen === right.dkLen;
}

function wipeEntry(entry: CacheEntry | undefined): void {
  if (entry === undefined) return;
  entry.key.fill(0);
  entry.fingerprint.fill(0);
}

export class VaultDerivedKeyCache {
  #fingerprintKey: Buffer = randomBytes(32);
  readonly #entries = new Map<string, CacheEntry>();
  readonly #inflight = new Map<string, Promise<Buffer>>();
  #generation = 0;
  readonly #onTiming: ((record: VaultTimingRecord) => void) | undefined;

  constructor(options: VaultDerivedKeyCacheOptions = {}) {
    this.#onTiming = options.onTiming;
  }

  /** Advances on every `clear()`; an operation from an older generation never touches the cache. */
  get generation(): number {
    return this.#generation;
  }

  /** Number of vault files with a cached key (0 or 1 per file). */
  get size(): number {
    return this.#entries.size;
  }

  /** Drop every key, zero-fill it, and invalidate in-flight operations. */
  clear(): void {
    this.#generation += 1;
    for (const entry of this.#entries.values()) wipeEntry(entry);
    this.#entries.clear();
    this.#inflight.clear();
    this.#fingerprintKey.fill(0);
    this.#fingerprintKey = randomBytes(32);
  }

  /** Drop the key for one vault file (a cached key failed the GCM tag). */
  drop(filePath: string): void {
    const path = resolve(filePath);
    wipeEntry(this.#entries.get(path));
    this.#entries.delete(path);
  }

  /**
   * A private copy of the cached key when the file, salt, params and password
   * all match, else null. The caller zero-fills the copy after use.
   */
  lookup(filePath: string, salt: Buffer, params: VaultKdfParams, password: string): Buffer | null {
    const entry = this.#entries.get(resolve(filePath));
    if (entry === undefined) return null;
    if (!sameParams(entry.params, params) || !entry.salt.equals(salt)) return null;
    const fingerprint = this.#fingerprint(password);
    const matches = timingSafeEqual(fingerprint, entry.fingerprint);
    fingerprint.fill(0);
    return matches ? copyKey(entry.key) : null;
  }

  /**
   * Run `derive` once for concurrent callers with the same inputs (single
   * flight) and hand each caller its own copy of the result. `started` is
   * true for the caller whose call actually ran the KDF.
   */
  async derive(
    filePath: string,
    salt: Buffer,
    params: VaultKdfParams,
    password: string,
    derive: () => Promise<Buffer>,
  ): Promise<{ readonly key: Buffer; readonly started: boolean }> {
    const flightKey = this.#flightKey(filePath, salt, params, password);
    let flight = this.#inflight.get(flightKey);
    let started = false;
    if (flight === undefined) {
      started = true;
      const pending = derive();
      flight = pending;
      this.#inflight.set(flightKey, pending);
      const settle = (): void => {
        if (this.#inflight.get(flightKey) === pending) this.#inflight.delete(flightKey);
      };
      pending.then(settle, settle);
    }
    const shared = await flight;
    return { key: copyKey(shared), started };
  }

  /**
   * Keep `key` as this file's entry, replacing any older one. Ignored when the
   * cache was cleared after `generation` was taken, so a lock that lands while
   * an operation is deriving always wins.
   */
  store(
    filePath: string,
    salt: Buffer,
    params: VaultKdfParams,
    password: string,
    key: Buffer,
    generation: number,
  ): void {
    if (generation !== this.#generation) return;
    const path = resolve(filePath);
    wipeEntry(this.#entries.get(path));
    this.#entries.set(path, {
      salt: Buffer.from(salt),
      params: { N: params.N, r: params.r, p: params.p, dkLen: params.dkLen },
      fingerprint: this.#fingerprint(password),
      key: copyKey(key),
    });
  }

  /** Start the bookkeeping for one vault operation. */
  beginOperation(
    filePath: string,
    op: VaultTimingOperation,
    label: string | undefined,
    requestedAtMs: number,
    generation: number,
  ): VaultKeyCacheOperation {
    return new VaultKeyCacheOperation(this, filePath, op, label ?? null, requestedAtMs, generation);
  }

  /** @internal Called by {@link VaultKeyCacheOperation.finish}. */
  report(record: VaultTimingRecord): void {
    if (this.#onTiming === undefined) return;
    try {
      this.#onTiming(record);
    } catch {
      // A timing sink must never fail a vault operation.
    }
  }

  #fingerprint(password: string): Buffer {
    return createHmac("sha256", this.#fingerprintKey).update(password, "utf8").digest();
  }

  #flightKey(filePath: string, salt: Buffer, params: VaultKdfParams, password: string): string {
    const fingerprint = this.#fingerprint(password);
    const key = [
      resolve(filePath),
      salt.toString("base64"),
      `${params.N}:${params.r}:${params.p}:${params.dkLen}`,
      fingerprint.toString("base64"),
    ].join("\u0000");
    fingerprint.fill(0);
    return key;
  }
}

/**
 * The cache as seen by ONE vault operation. It touches the cache only while
 * the generation it was requested under is still current; after a clear it
 * behaves like the uncached path (no lookup, no store).
 */
export class VaultKeyCacheOperation {
  cacheHit = 0;
  cacheMiss = 0;
  tagRetry = 0;
  derives = 0;
  deriveMs = 0;
  readonly #startedAtMs: number;

  constructor(
    readonly cache: VaultDerivedKeyCache,
    readonly filePath: string,
    readonly op: VaultTimingOperation,
    readonly label: string | null,
    readonly requestedAtMs: number,
    readonly generation: number,
  ) {
    this.#startedAtMs = performance.now();
  }

  /** False once the cache was cleared after this operation was requested. */
  get current(): boolean {
    return this.cache.generation === this.generation;
  }

  finish(): void {
    const now = performance.now();
    this.cache.report({
      op: this.op,
      label: this.label,
      cacheHit: this.cacheHit,
      cacheMiss: this.cacheMiss,
      tagRetry: this.tagRetry,
      derives: this.derives,
      deriveMs: Math.round(this.deriveMs),
      lockWaitMs: Math.round(this.#startedAtMs - this.requestedAtMs),
      totalMs: Math.round(now - this.requestedAtMs),
    });
  }
}
