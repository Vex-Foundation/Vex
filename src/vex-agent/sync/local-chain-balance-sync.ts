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
 * swap/bridge auto-pin hooks) ∪ the identity candidates the chain's indexer
 * enumerated (Blockscout, on every local chain whose config sets
 * `hasBlockscoutIndexer`: Robinhood 4663, Arc 5042). The union itself is owned by the pure
 * `wallet-inventory/local-chain.ts`; this module performs the two reads that
 * feed it. The indexer is authoritative for IDENTITY ONLY - every balance,
 * scale and symbol below is re-read from RPC.
 *
 * Whole-chain replacement requires exhaustive discovery. When discovery is
 * unavailable, known identities (including cached holdings) still read from
 * RPC and only those identities are replaced. An RPC failure preserves their
 * last good rows; database failures propagate.
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
import { readBlockscoutErc20IdentityCandidates } from "@tools/blockscout/client.js";
import { getBlockscoutBaseUrlForChain } from "@tools/blockscout/operation.js";
import {
  buildLocalChainScanSet,
  fromBlockscoutInventory,
  type LocalChainIndexerObservation,
  type LocalChainScanSet,
} from "@vex-agent/wallet-inventory/local-chain.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import logger from "@utils/logger.js";
import { createTransitionLog } from "@utils/transition-log.js";

const enumerationLog = createTransitionLog();

export interface LocalChainSyncResult {
  chainId: number;
  tokensUpdated: number;
  /** True when the chain was skipped (unknown/ non-EVM) or a soft failure. */
  skipped: boolean;
  readStatus?: "ok" | "inventory_incomplete" | "read_failed";
  /** Classified failure of either the balance read or inventory discovery. */
  reason?: string | null;
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
 *
 * A successful read refreshes every known holding even if discovery failed.
 * A failed balance read writes nothing. Only an exhaustive inventory permits
 * whole-chain replacement.
 */
export async function syncLocalChainForWallet(
  family: ChainFamily,
  walletAddress: string,
  chainId: number,
): Promise<LocalChainSyncResult> {
  const config = getLocalChain(chainId);
  if (!config || family !== "eip155") {
    return { chainId, tokensUpdated: 0, skipped: true, readStatus: "read_failed", reason: "unsupported_chain" };
  }

  // DB READ — propagates. A failing pinned-token query is a local-DB fault the
  // operator must see, not a condition to paper over with a skipped chain. The
  // indexer read inside is fail-soft and reports itself through `exhaustive`.
  const inventory = await buildLocalChainInventory(config, walletAddress);
  const cached = await balancesRepo.getBalances(walletAddress, chainId);
  const knownAddresses = new Set(inventory.addresses);
  try {
    for (const row of cached) {
      if (row.tokenAddress.toLowerCase() !== NATIVE_TOKEN_ADDRESS.toLowerCase()) {
        knownAddresses.add(getAddress(row.tokenAddress));
      }
    }
  } catch {
    return { chainId, tokensUpdated: 0, skipped: true, readStatus: "read_failed", reason: "invalid_response" };
  }
  const tokenAddrs = [...knownAddresses];

  // Discovery completeness and a successful balance read are independent facts.
  //
  // A chain with NO indexer at all (`config.hasBlockscoutIndexer` false -
  // seed + pins only, by product decision; see registry.ts) can NEVER become
  // exhaustive: there is nothing to retry. Warning the user "retry after
  // checking the connection" for a gap that is permanent by design is
  // misleading, so that log/warning path is scoped to chains that DO have an
  // indexer and it came back incomplete (Blockscout returning a transient
  // 403, hitting its row cap, etc.) - a real, retry-worthy condition.
  const logKey = `${walletAddress}:${chainId}`;
  const hasIndexer = inventory.indexer !== null;
  if (!inventory.exhaustive && hasIndexer) {
    const reason = inventory.indexer?.incompleteReason ?? "enumeration_not_exhaustive";
    const signal = enumerationLog.observe(logKey, `${reason}:${tokenAddrs.length}:${inventory.droppedAddresses.length}`);
    if (signal !== undefined) logger.warn("sync.local_chain.enumeration_not_exhaustive", {
      chainId,
      address: walletAddress.slice(0, 10) + "...",
      indexerSource: inventory.indexer?.source ?? null,
      indexerReason: reason,
      endpointHost: new URL(getBlockscoutBaseUrlForChain(chainId)).hostname,
      ...signal,
      unprocessedContracts: inventory.indexer?.unprocessedContractAddresses.length ?? 0,
      droppedAddresses: inventory.droppedAddresses.length,
      scanned: tokenAddrs.length,
    });
  }
  const recovered = inventory.exhaustive ? enumerationLog.clear(logKey) : undefined;
  if (recovered) logger.info("sync.local_chain.enumeration_recovered", { chainId, ...recovered });

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
    return { chainId, tokensUpdated: 0, skipped: true, readStatus: "read_failed", reason: "rpc_failed" };
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
    return { chainId, tokensUpdated: 0, skipped: true, readStatus: "read_failed", reason: "read_incomplete" };
  }

  const rows = buildBalanceRows(family, walletAddress, config, read);

  // DB WRITE — propagates. A failed transactional replace must fail the sync
  // run visibly (worker retry semantics), never masquerade as a skipped chain.
  const count = inventory.exhaustive
    ? await balancesRepo.replaceBalancesForChain(walletAddress, chainId, rows)
    : await balancesRepo.replaceKnownEvmBalancesForChain(
        walletAddress, chainId, [...tokenAddrs, NATIVE_TOKEN_ADDRESS], rows,
      );
  logger.info("sync.local_chain.completed", {
    chainId,
    address: walletAddress.slice(0, 10) + "...",
    tokens: count,
    scanned: tokenAddrs.length,
    // WHY each price was chosen: tier 0 is a stablecoin-quoted pool, tier 1 is
    // wrapped-native-quoted x our native price, and `unpriced` is what our own
    // rule refused rather than guessed at.
    priceTiers: read.priceTiers,
  });
  // A chain with no indexer (`hasIndexer` false) is reported `"ok"`: seeds +
  // pins IS the complete read this chain can ever offer, so there is no
  // discovery gap to surface — only a chain whose indexer came back
  // incomplete has one worth warning about.
  return {
    chainId, tokensUpdated: count, skipped: false,
    readStatus: inventory.exhaustive || !hasIndexer ? "ok" : "inventory_incomplete",
    reason: inventory.exhaustive || !hasIndexer ? null : (inventory.indexer?.incompleteReason ?? "enumeration_not_exhaustive"),
  };
}

// ── Token scan set ──────────────────────────────────────────────────

/**
 * Enumerate this chain's scan set for this wallet: seeds ∪ explicit pins ∪ the
 * indexer's identity candidates, deduplicated, checksummed and ordered by the
 * pure union owner. Exported for the live `WalletBalances` read path, which
 * enumerates the SAME set - the live read and the projection must never
 * disagree about which tokens exist.
 *
 * Two different failure contracts meet here, deliberately:
 * - the DB pin read PROPAGATES (a local-DB fault the operator must see);
 * - the indexer read never throws except on caller cancellation; an outage
 *   returns a non-exhaustive set, which every caller must honour.
 */
export async function buildLocalChainInventory(
  config: LocalChainConfig,
  walletAddress: string,
  options: { signal?: AbortSignal } = {},
): Promise<LocalChainScanSet> {
  const pinnedAddresses = await trackedTokensRepo.getTrackedTokenAddressesForChain(
    walletAddress,
    config.id,
  );
  const indexer = await readIdentityCandidates(config, walletAddress, options.signal);
  return buildLocalChainScanSet({
    chainId: config.id,
    seedAddresses: config.seedTokens.map((token) => token.address),
    // The native-shadow address (Arc's dual native/ERC-20 USDC) is excluded
    // from BOTH sources here, never just seeds: a pin or an indexer candidate
    // is exactly as capable of reintroducing the native row's own funds as a
    // second, phantom holding. Dropped BEFORE the union, not after, so this
    // never counts as a failed/incomplete indexer candidate (see
    // `LocalChainScanSet.droppedAddresses`) - it was never a distinct
    // identity to begin with, so omitting it costs nothing towards
    // `exhaustive`.
    pinnedAddresses: dropNativeShadowAddress(config, pinnedAddresses),
    indexer: indexer === null ? null : {
      ...indexer,
      candidates: indexer.candidates.filter(
        (candidate) => !isNativeShadowAddress(config, candidate.address),
      ),
    },
  });
}

/** True when `address` is this chain's dual native/ERC-20 shadow, if it has one. */
function isNativeShadowAddress(config: LocalChainConfig, address: string): boolean {
  return config.nativeShadowTokenAddress !== undefined
    && address.toLowerCase() === config.nativeShadowTokenAddress.toLowerCase();
}

function dropNativeShadowAddress(
  config: LocalChainConfig,
  addresses: readonly string[],
): readonly string[] {
  if (config.nativeShadowTokenAddress === undefined) return addresses;
  return addresses.filter((address) => !isNativeShadowAddress(config, address));
}

/**
 * The identity enumerator for this chain, or null when it has none.
 *
 * Blockscout is scoped to the chains whose config opts in via
 * `hasBlockscoutIndexer` (see `tools/blockscout/BLOCKSCOUT.md`), so a chain
 * with no Blockscout instance at all never lies about not having one.
 */
async function readIdentityCandidates(
  config: LocalChainConfig,
  walletAddress: string,
  signal: AbortSignal | undefined,
): Promise<LocalChainIndexerObservation | null> {
  if (!config.hasBlockscoutIndexer) return null;
  return fromBlockscoutInventory(
    await readBlockscoutErc20IdentityCandidates(config.id, walletAddress, { signal }),
  );
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
  //
  // Defensive final guard, belt-and-suspenders with `buildLocalChainInventory`
  // already excluding this address from the scan set: a wallet that was
  // synced before that exclusion existed can have a STALE cached row for the
  // native-shadow address (see `dropNativeShadowAddress`), which re-enters
  // `tokenAddrs` through the cached-known-addresses union in
  // `syncLocalChainForWallet` and gets re-scanned one more time here. Skipping
  // it at row assembly, rather than only at scan-set build, means an already
  // exhaustive replace (`replaceBalancesForChain`) self-heals the duplicate
  // out of `proj_balances` on its own, with no migration needed.
  for (const token of read.tokens) {
    if (isNativeShadowAddress(config, token.address)) continue;
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
