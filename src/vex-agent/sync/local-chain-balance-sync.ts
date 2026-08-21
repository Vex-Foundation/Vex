/**
 * Direct-RPC balance sync for local (non-Khalani) EVM chains.
 *
 * Khalani provides balances for the chains it covers (see
 * `sync/balance-sync.ts` → `getTokenBalancesAcrossChains`). Chains in the LOCAL
 * registry (`tools/evm-chains/registry.ts`, e.g. Robinhood Chain 4663) are read
 * straight from RPC and written through the SAME transactional per-chain
 * replace (`balancesRepo.replaceBalancesForChain`), so the projection layer,
 * snapshots, and `active_chains` treat them identically to Khalani chains.
 *
 * The RPC + pricing implementation is SHARED with the live `WalletBalances`
 * read path: `tools/evm-chains/balances.ts` (`readLocalChainBalances`). This
 * module owns the sync-specific parts: the token scan set, the fail-soft
 * policy, and the `proj_balances` row assembly.
 *
 * Token set = the chain's seed set ∪ the wallet's EXPLICIT pins
 * (`tracked_tokens` — written by the `WalletTrackToken` tool and the
 * swap/bridge auto-pin hooks). This replaced the implicit spot-swap derivation
 * (Robinhood launch): explicit rows cover bridged, transferred, and airdropped
 * tokens that the old derivation could never see.
 *
 * Failure semantics (Codex final-review fix): fail-soft (return skipped, keep
 * the last-good rows) applies ONLY to on-chain/RPC/transport failures —
 * multicall reads, RPC connect, DexScreener pricing. DB failures — the
 * pinned-token read (`getTrackedTokenAddressesForChain`) and the transactional
 * write (`replaceBalancesForChain`) — PROPAGATE so the sync run fails visibly
 * and retries per existing worker semantics, exactly like DB errors on the
 * Khalani sync path.
 */

import { formatUnits, getAddress } from "viem";

import { NATIVE_TOKEN_ADDRESS } from "@tools/kyberswap/constants.js";
import {
  readLocalChainBalances,
  type LocalChainBalancesRead,
} from "@tools/evm-chains/balances.js";
import { getLocalChain, type LocalChainConfig } from "@tools/evm-chains/registry.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import * as balancesRepo from "@vex-agent/db/repos/balances.js";
import * as trackedTokensRepo from "@vex-agent/db/repos/tracked-tokens.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import logger from "@utils/logger.js";

export interface LocalChainSyncResult {
  chainId: number;
  tokensUpdated: number;
  /** True when the chain was skipped (unknown/ non-EVM) or a soft failure. */
  skipped: boolean;
}

/**
 * Sync one local chain for one wallet: read balances, price them, and replace
 * the wallet's rows for this chain in `proj_balances`. Address-only — never
 * touches key material.
 *
 * Error boundary: the DB read (token scan set) and DB write (transactional
 * replace) sit OUTSIDE the RPC try/catch — a DB failure rejects loudly so the
 * worker marks the run failed (matching the Khalani path). Only the on-chain /
 * pricing reads in between are fail-soft.
 */
export async function syncLocalChainForWallet(
  family: ChainFamily,
  walletAddress: string,
  chainId: number,
): Promise<LocalChainSyncResult> {
  const config = getLocalChain(chainId);
  if (!config || family !== "eip155") {
    return { chainId, tokensUpdated: 0, skipped: true };
  }

  // DB READ — propagates. A failing pinned-token query is a local-DB fault the
  // operator must see, not a condition to paper over with a skipped chain.
  const tokenAddrs = await buildTokenScanSet(config, walletAddress);

  // RPC/TRANSPORT — fail-soft. No write happens on this path, so cached rows
  // for this chain survive a transient RPC outage (mirrors the Khalani native
  // top-up guard).
  let read: LocalChainBalancesRead;
  try {
    read = await readLocalChainBalances(config, walletAddress, tokenAddrs);
  } catch (err) {
    // SECURITY: never surface the raw provider error (it can carry the RPC URL /
    // HTML bodies) — log a bounded message class only.
    logger.warn("sync.local_chain.failed", {
      chainId,
      address: walletAddress.slice(0, 10) + "...",
      error: err instanceof Error ? err.name : "unknown",
    });
    return { chainId, tokensUpdated: 0, skipped: true };
  }

  // A4: `replaceBalancesForChain` replaces the chain's WHOLE snapshot, so it
  // may only run on a COMPLETE read. `multicall({ allowFailure: true })` answers
  // per contract, so one token can fail while the rest succeed - writing that
  // partial set would DELETE a previously valid row, and the agent would read
  // the deletion as "you hold none of it". Preserve the last-good rows instead.
  if (read.tokenFailures.length > 0) {
    logger.warn("sync.local_chain.read_incomplete", {
      chainId,
      address: walletAddress.slice(0, 10) + "...",
      failedTokens: read.tokenFailures.length,
      scanned: tokenAddrs.length,
      reasons: [...new Set(read.tokenFailures.map((failure) => failure.reason))],
    });
    return { chainId, tokensUpdated: 0, skipped: true };
  }

  const rows = buildBalanceRows(family, walletAddress, config, read);

  // DB WRITE — propagates. A failed transactional replace must fail the sync
  // run visibly (worker retry semantics), never masquerade as a skipped chain.
  const count = await balancesRepo.replaceBalancesForChain(walletAddress, chainId, rows);
  logger.info("sync.local_chain.completed", {
    chainId,
    address: walletAddress.slice(0, 10) + "...",
    tokens: count,
    scanned: tokenAddrs.length,
  });
  return { chainId, tokensUpdated: count, skipped: false };
}

// ── Token scan set ──────────────────────────────────────────────────

/**
 * Seed set ∪ explicitly pinned tokens, deduped case-insensitively and
 * checksummed. Malformed pinned addresses are dropped defensively (untrusted
 * DB rows). Exported for the live `WalletBalances` read path, which scans the
 * SAME set.
 */
export async function buildTokenScanSet(
  config: LocalChainConfig,
  walletAddress: string,
): Promise<`0x${string}`[]> {
  const byLower = new Map<string, `0x${string}`>();
  const add = (raw: string): void => {
    try {
      const checksummed = getAddress(raw);
      byLower.set(checksummed.toLowerCase(), checksummed);
    } catch {
      // Not a valid EVM address — skip (defensive against bad DB data).
    }
  };

  for (const token of config.seedTokens) add(token.address);

  const pinned = await trackedTokensRepo.getTrackedTokenAddressesForChain(walletAddress, config.id);
  for (const address of pinned) add(address);

  return [...byLower.values()];
}

// ── Row assembly ────────────────────────────────────────────────────

function buildBalanceRows(
  family: ChainFamily,
  walletAddress: string,
  config: LocalChainConfig,
  read: LocalChainBalancesRead,
): BalanceRow[] {
  const rows: BalanceRow[] = [];

  // Native coin. Its USD price rides on wrapped-native (WETH), which is in the
  // seed set — ETH ≈ WETH. Zero native balances are skipped (Khalani parity).
  if (read.nativeWei > 0n) {
    rows.push(
      toRow(family, walletAddress, config.id, {
        tokenAddress: NATIVE_TOKEN_ADDRESS,
        symbol: config.nativeCurrency.symbol,
        decimals: config.nativeCurrency.decimals,
        balanceWei: read.nativeWei,
        priceUsd: read.nativePriceUsd,
      }),
    );
  }

  // ERC-20s: the reader skipped zero balances, and a read failure has already
  // short-circuited this whole pass above.
  for (const token of read.tokens) {
    rows.push(
      toRow(family, walletAddress, config.id, {
        tokenAddress: token.address,
        symbol: token.symbol,
        decimals: token.decimals,
        balanceWei: token.balanceWei,
        priceUsd: token.priceUsd,
      }),
    );
  }
  return rows;
}

function toRow(
  family: ChainFamily,
  walletAddress: string,
  chainId: number,
  token: { tokenAddress: string; symbol: string; decimals: number; balanceWei: bigint; priceUsd: number | null },
): BalanceRow {
  let balanceUsd: number | null = null;
  if (token.priceUsd !== null) {
    const human = Number(formatUnits(token.balanceWei, token.decimals));
    if (Number.isFinite(human)) balanceUsd = human * token.priceUsd;
  }
  return {
    walletFamily: family,
    walletAddress,
    chainId,
    tokenAddress: token.tokenAddress,
    tokenSymbol: token.symbol,
    tokenName: null,
    balanceRaw: token.balanceWei.toString(),
    balanceUsd,
    priceUsd: token.priceUsd,
    decimals: token.decimals,
  };
}

/** Test-only re-export: clear the shared in-process metadata cache. */
export { resetLocalChainMetadataCache } from "@tools/evm-chains/balances.js";
