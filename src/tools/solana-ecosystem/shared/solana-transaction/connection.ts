/**
 * Solana `Connection` construction from config, plus the cached singleton the
 * Jupiter shelves use.
 *
 * `createSolanaConnection` is the single owner of "how a Connection is built
 * from `config.solana`". `getSolanaConnection()` is that factory with no
 * overrides, memoized; callers that need a per-operation transport (the
 * balance reader owns a deadline and must be able to CANCEL its HTTP request)
 * build their own through the factory instead of mutating the singleton.
 */

import { Connection, type Commitment, type FetchFn } from "@solana/web3.js";
import { loadConfig } from "../../../../config/store.js";

// ── Factory ─────────────────────────────────────────────────────

export interface SolanaConnectionOptions {
  /** Overrides `config.solana.rpcUrl`. */
  readonly rpcUrl?: string;
  /** Overrides `config.solana.commitment` (default "confirmed"). */
  readonly commitment?: Commitment;
  /**
   * Custom transport, forwarded to `ConnectionConfig.fetch`
   * (`@solana/web3.js@1.98.4` `lib/index.d.ts:3180`, `FetchFn` at :3158).
   * Omitted means web3.js's own default, which is `globalThis.fetch` on
   * Node 18+ (`lib/index.esm.js:4245`).
   */
  readonly fetch?: FetchFn;
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
  const rpcUrl = options.rpcUrl ?? cfg.solana.rpcUrl;
  const commitment = options.commitment ?? ((cfg.solana.commitment ?? "confirmed") as Commitment);
  return new Connection(rpcUrl, { commitment, fetch: options.fetch });
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
