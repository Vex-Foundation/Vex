/**
 * Tracked-tokens repo — explicit token pins for LOCAL (non-Khalani) chains.
 *
 * Feeds the local-chain balance scan set (seed ∪ pins). Writes come from the
 * `WalletTrackToken` tool and from the auto-pin hooks in the uniswap swap /
 * relay bridge execute handlers. Addresses are stored as given (checksummed by
 * callers); identity is case-insensitive via the unique LOWER() index.
 */

import { query, queryOne, execute } from "../client.js";

export type TrackedTokenSource = "agent" | "swap" | "bridge";

export interface TrackedToken {
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  source: TrackedTokenSource;
  createdAt: string;
}

/** Pin a token. Idempotent — an existing pin (any source) is left untouched. */
export async function pinTrackedToken(input: {
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
  source: TrackedTokenSource;
}): Promise<{ inserted: boolean }> {
  const row = await queryOne<{ id: string }>(
    `INSERT INTO tracked_tokens (wallet_address, chain_id, token_address, source)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (wallet_address, chain_id, LOWER(token_address)) DO NOTHING
     RETURNING id`,
    [input.walletAddress, input.chainId, input.tokenAddress, input.source],
  );
  return { inserted: row !== null };
}

/** Unpin a token (case-insensitive address match). Returns rows removed. */
export async function unpinTrackedToken(input: {
  walletAddress: string;
  chainId: number;
  tokenAddress: string;
}): Promise<number> {
  return execute(
    `DELETE FROM tracked_tokens
      WHERE wallet_address = $1 AND chain_id = $2 AND LOWER(token_address) = LOWER($3)`,
    [input.walletAddress, input.chainId, input.tokenAddress],
  );
}

/** All pins for one wallet on one chain, oldest first. */
export async function listTrackedTokens(input: {
  walletAddress: string;
  chainId: number;
}): Promise<TrackedToken[]> {
  const rows = await query<Record<string, unknown>>(
    `SELECT wallet_address, chain_id, token_address, source, created_at
       FROM tracked_tokens
      WHERE wallet_address = $1 AND chain_id = $2
      ORDER BY created_at ASC, id ASC`,
    [input.walletAddress, input.chainId],
  );
  return rows.map((r) => ({
    walletAddress: String(r.wallet_address),
    chainId: Number(r.chain_id),
    tokenAddress: String(r.token_address),
    source: r.source as TrackedTokenSource,
    createdAt: r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at),
  }));
}

/** Pinned addresses for the scan set (order irrelevant — callers dedupe). */
export async function getTrackedTokenAddressesForChain(
  walletAddress: string,
  chainId: number,
): Promise<string[]> {
  const rows = await query<{ token_address: string }>(
    `SELECT token_address FROM tracked_tokens
      WHERE wallet_address = $1 AND chain_id = $2`,
    [walletAddress, chainId],
  );
  return rows.map((r) => r.token_address);
}
