/**
 * Solana `Connection` construction from config, plus the cached singleton the
 * Jupiter shelves use, plus the endpoint table that decides WHICH url a
 * connection gets.
 *
 * `createSolanaConnection` is the single owner of "how a Connection is built
 * from `config.solana`". `getSolanaConnection()` is that factory with no
 * overrides, memoized; callers that need a per-operation transport (the balance
 * reader owns a deadline and must be able to CANCEL its HTTP request) build
 * their own through the factory instead of mutating the singleton.
 *
 * Read and broadcast remain separate roles. Live balance probes on 2026-09-08
 * found the previously bundled publicnode endpoint refused getBalance and
 * both token-account reads with HTTP 403. The canonical mainnet endpoint
 * answered all three with HTTP 200, including both token programs. Bundled
 * installs now use that measured working endpoint; custom URLs still win.
 */

import { Connection, type Commitment, type FetchFn } from "@solana/web3.js";
import { loadConfig } from "../../../../config/store.js";

// ── Endpoint table ──────────────────────────────────────────────────

/** What a connection is for. Decides which bundled endpoint it gets. */
export type SolanaRpcRole = "read" | "broadcast";

/** Keyless endpoint verified for native, SPL and Token-2022 balance reads. */
const SOLANA_READ_URL = "https://api.mainnet-beta.solana.com";

/**
 * The endpoint this repository has always broadcast through, kept for broadcast
 * until a gated live smoke proves the read endpoint accepts a transaction.
 */
const SOLANA_BROADCAST_URL = "https://api.mainnet-beta.solana.com";

/**
 * Endpoints this repository has ever SHIPPED as the bundled default.
 *
 * A stored `config.solana.rpcUrl` equal to one of these is a bundled default
 * that a past install wrote into the file, not a choice the user made, so the
 * table's current answer supersedes it. Any other value is the user's own
 * endpoint and always wins - rule 90's local-first posture. Without this list a
 * measured endpoint change would reach new installs only and leave every
 * existing one on the slow endpoint forever.
 */
const SUPERSEDED_BUNDLED_URLS: ReadonlySet<string> = new Set([
  "https://api.mainnet-beta.solana.com",
  "https://solana-rpc.publicnode.com",
]);

/**
 * The url a connection for `role` should use: the user's own endpoint when they
 * configured one, otherwise the bundled endpoint for that role.
 */
export function resolveSolanaRpcUrl(role: SolanaRpcRole = "read"): string {
  const configured = loadConfig().solana.rpcUrl?.trim();
  if (configured !== undefined && configured.length > 0 && !SUPERSEDED_BUNDLED_URLS.has(configured)) {
    return configured;
  }
  return role === "broadcast" ? SOLANA_BROADCAST_URL : SOLANA_READ_URL;
}

// ── Factory ─────────────────────────────────────────────────────

export interface SolanaConnectionOptions {
  /** Overrides everything, including the user's configured endpoint. */
  readonly rpcUrl?: string;
  /**
   * What this connection is for. `"broadcast"` pins the endpoint a signature
   * reaches; `"read"` (the default) takes the endpoint verified for balance reads. Ignored when
   * the user configured their own endpoint, which serves both roles.
   */
  readonly role?: SolanaRpcRole;
  /** Overrides `config.solana.commitment` (default "confirmed"). */
  readonly commitment?: Commitment;
  /**
   * Custom transport, forwarded to `ConnectionConfig.fetch`
   * (`@solana/web3.js@1.98.4` `lib/index.d.ts:3180`, `FetchFn` at :3158).
   * Omitted means web3.js's own default, which is `globalThis.fetch` on
   * Node 18+ (`lib/index.esm.js:4245`).
   */
  readonly fetch?: FetchFn;
  /**
   * Forwarded to `ConnectionConfig.disableRetryOnRateLimit`
   * (`@solana/web3.js@1.98.4` `lib/index.d.ts:3184`).
   *
   * MEASURED behaviour of the default (`lib/index.cjs.js:5053-5075`): on HTTP
   * 429 the client retries up to five times, sleeping 500, 1000, 2000 then
   * 4000 ms - 7.5 s in total - and writes a `console.error` line per retry.
   * A caller that owns a deadline of its own therefore has most of its budget
   * spent inside the library, and reports a TIMEOUT for what was a rate limit.
   *
   * OMITTED BY DEFAULT, deliberately: the shared `getSolanaConnection()`
   * singleton keeps web3.js's own retry behaviour, because it has no deadline
   * of its own and no way to report the distinction. Only a caller that owns a
   * deadline AND can surface a typed rate-limited outcome should pass `true`.
   *
   * Setting it true adds NO retry anywhere: it removes one, and hands the
   * retry decision to whoever owns the deadline.
   */
  readonly disableRetryOnRateLimit?: boolean;
}

/**
 * Build a `Connection` from config with optional overrides.
 *
 * Passing `{ commitment }` as a `ConnectionConfig` is equivalent to passing the
 * commitment string: the constructor's object branch sets `_commitment` from it
 * and leaves every other field undefined, exactly as the string branch does
 * (`lib/index.esm.js:6056-6067`).
 */
export function createSolanaConnection(options: SolanaConnectionOptions = {}): Connection {
  const cfg = loadConfig();
  const rpcUrl = options.rpcUrl ?? resolveSolanaRpcUrl(options.role ?? "read");
  const commitment = options.commitment ?? ((cfg.solana.commitment ?? "confirmed") as Commitment);
  return new Connection(rpcUrl, {
    commitment,
    fetch: options.fetch,
    disableRetryOnRateLimit: options.disableRetryOnRateLimit,
  });
}

// ── Connection singleton ────────────────────────────────────────

let connectionInstance: Connection | null = null;

export function getSolanaConnection(): Connection {
  if (connectionInstance) return connectionInstance;

  connectionInstance = createSolanaConnection();
  return connectionInstance;
}

export function resetSolanaConnection(): void {
  connectionInstance = null;
}
