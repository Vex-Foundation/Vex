/**
 * Pendle balance enrichment (multichain) — Wave 5 + harness P2.
 *
 * Khalani's cross-chain balance scan can miss (or leave unpriced) exotic Pendle
 * PT tokens on the chains it DOES cover, and it cannot scan Pendle chains absent
 * from its dynamic registry at all (the scan throws). This module reads the
 * wallet's TRACKED Pendle PT balances straight from the chain's RPC, prices them
 * from that chain's Pendle asset catalogue, and exposes two paths:
 *
 *   - enrichPendleBalances(…, chainId, base): MERGE — supplements the rows the
 *     Khalani scan produced for a chain it refreshed. Deduped by address:
 *       · a Pendle-priced row WINS over a Khalani row with no price,
 *       · a Khalani row that already has a price WINS (upstream authoritative).
 *   - seedPendleChainBalances(…, chainId): STANDALONE SEED — for a Pendle chain
 *     Khalani CANNOT scan, reads PT balances and REPLACES the wallet's rows for
 *     that chain directly (the same transactional per-chain replace the Khalani /
 *     local-chain paths use). An empty result clears a stale PT row (post-sell).
 *
 * Chain scoping (critic #8): PT classification + price come from
 * `getAssetsForChain(chainId)` — a per-chain endpoint — and are re-checked
 * against `PendleAsset.chainId`, so the same bare address on two chains never
 * collides or poisons decimals.
 *
 * Failure semantics (2b doctrine): RPC + Pendle-API failures are FAIL-SOFT (merge
 * keeps the Khalani rows; seed skips its write and keeps last-good rows). The
 * tracked-token DB read and the seed's transactional write PROPAGATE so a
 * local-DB fault surfaces and the worker retries, exactly like the Khalani /
 * local-chain paths.
 *
 * DETERMINED-EMPTY vs UNKNOWN (H-1) is the load-bearing distinction here,
 * because the seed path DELETES rows on an empty result. "The wallet holds no PT
 * here" is a determined `[]`; "I could not classify anything" is `null`. When
 * `/v1/assets/all` silently degraded to an empty list, every tracked token
 * failed the `baseType === "PT"` test, so an UNKNOWN outcome was reported as a
 * determined empty one and the seed wiped the user's PT balances. An unreadable
 * catalogue now raises, and an empty catalogue for a Pendle chain is treated as
 * unknown rather than as proof the wallet holds nothing.
 */

import { formatUnits, getAddress, type Address } from "viem";

import { getPendleClient } from "@tools/pendle/client.js";
import { getPendlePublicClient } from "@tools/pendle/evm-client.js";
import { PENDLE_ERC20_ABI } from "@tools/pendle/constants.js";
import { pendleChainSlug } from "@tools/pendle/chains.js";
import type { PendleAsset } from "@tools/pendle/types.js";
import type { ChainFamily } from "@tools/khalani/types.js";
import * as trackedTokensRepo from "@vex-agent/db/repos/tracked-tokens.js";
import * as balancesRepo from "@vex-agent/db/repos/balances.js";
import type { BalanceRow } from "@vex-agent/db/repos/balances.js";
import logger from "@utils/logger.js";

export interface PendleSeedResult {
  chainId: number;
  /** Rows written to proj_balances for this chain. */
  tokensUpdated: number;
  /** True when skipped: non-Pendle chain, nothing tracked, or a soft RPC/API failure. */
  skipped: boolean;
}

/**
 * Compute the wallet's TRACKED Pendle PT balance rows on `chainId`:
 *   - `null`  → could not determine (non-EVM, non-Pendle chain, nothing tracked,
 *               or a FAIL-SOFT RPC/API error); callers MUST NOT touch existing rows.
 *   - `[]`    → determined: the wallet currently holds no PT balance here (tracked
 *               but zero / expired); the seed path uses this to clear stale rows.
 *   - rows    → the current PT balances, priced from the chain-scoped asset map.
 * The tracked-token DB read PROPAGATES (a local-DB fault must surface).
 */
async function collectPendlePtRows(
  family: ChainFamily,
  walletAddress: string,
  chainId: number,
): Promise<BalanceRow[] | null> {
  if (family !== "eip155") return null;
  const slug = pendleChainSlug(chainId);
  if (slug === undefined) return null;

  // DB READ — propagates (a failing tracked-token query is a local-DB fault the
  // operator must see, not a condition to paper over).
  //
  // Batch B card B2: the source is `tracked_tokens`, NOT `proj_activity`. The
  // Pendle tools are `capture: "none"` (same commit-atom) so they no longer
  // write the capture rows the old `activity.getTrackedEvmTokensForChain` scan
  // depended on; `pendle-acquisition-pin.ts` pins each confirmed acquisition
  // instead. `tracked_tokens` is chainId-keyed, so the chain scoping is exact
  // rather than slug-matched.
  const trackedAddrs = await trackedTokensRepo.getTrackedTokenAddressesForChain(walletAddress, chainId);
  if (trackedAddrs.length === 0) return null;

  // RPC + API — FAIL-SOFT. On any error, signal "don't touch existing rows".
  try {
    // Per-chain catalogue; the chainId re-check keeps a foreign row out of the
    // map (critic #8 decimals/price poisoning).
    const assets = await getPendleClient().getAssetsForChain(chainId);
    const assetByLower = new Map<string, PendleAsset>();
    for (const a of assets) {
      if (a.chainId !== null && a.chainId !== chainId) continue;
      assetByLower.set(a.address.toLowerCase(), a);
    }
    // A Pendle-registry chain always has a catalogue. An empty one means we
    // cannot classify ANY tracked token, which is UNKNOWN — not proof that the
    // wallet holds no PT. Returning [] here would let the seed delete real rows.
    if (assetByLower.size === 0) {
      logger.warn("sync.pendle_enrichment.empty_asset_catalog", { chainId });
      return null;
    }

    // Restrict to tokens Pendle recognizes as PT ON THIS CHAIN (self-limiting to
    // PT holdings — the pins written by `pendle-acquisition-pin.ts` also cover
    // YT/LP, which this balance path deliberately does not price).
    const ptAddrs: Address[] = [];
    for (const raw of trackedAddrs) {
      let addr: Address;
      try {
        addr = getAddress(raw);
      } catch {
        continue;
      }
      if (assetByLower.get(addr.toLowerCase())?.baseType === "PT") ptAddrs.push(addr);
    }
    if (ptAddrs.length === 0) return [];

    const client = getPendlePublicClient(chainId);
    const owner = getAddress(walletAddress);
    const reads = await client.multicall({
      allowFailure: true,
      contracts: ptAddrs.map(
        (address) => ({ address, abi: PENDLE_ERC20_ABI, functionName: "balanceOf", args: [owner] }) as const,
      ),
    });

    const rows: BalanceRow[] = [];
    for (let i = 0; i < ptAddrs.length; i++) {
      const read = reads[i];
      if (read?.status !== "success") continue;
      const balance = read.result as bigint;
      if (balance <= 0n) continue;
      const address = ptAddrs[i]!;
      const asset = assetByLower.get(address.toLowerCase())!;
      const decimals = asset.decimals ?? 18;
      const priceUsd = asset.priceUsd;
      const human = Number(formatUnits(balance, decimals));
      const balanceUsd = priceUsd !== null && Number.isFinite(human) ? human * priceUsd : null;
      rows.push({
        walletFamily: family,
        walletAddress,
        chainId,
        tokenAddress: address,
        tokenSymbol: asset.symbol,
        tokenName: null,
        balanceRaw: balance.toString(),
        balanceUsd,
        priceUsd,
        decimals,
      });
    }
    return rows;
  } catch (err) {
    logger.warn("sync.pendle_enrichment.failed", {
      chainId,
      address: walletAddress.slice(0, 10) + "...",
      error: err instanceof Error ? err.name : "unknown",
    });
    return null;
  }
}

/**
 * MERGE tracked Pendle PT rows into a chain's balance set (dedup by address).
 * `baseRows` is the set the caller (Khalani sync) will write for `chainId`;
 * returns the merged set. DB read propagates; RPC/API failure keeps `baseRows`.
 */
export async function enrichPendleBalances(
  family: ChainFamily,
  walletAddress: string,
  chainId: number,
  baseRows: BalanceRow[],
): Promise<BalanceRow[]> {
  const rows = await collectPendlePtRows(family, walletAddress, chainId);
  if (rows === null || rows.length === 0) return baseRows;
  return mergePendleRows(baseRows, rows);
}

/**
 * STANDALONE seed for a Pendle chain Khalani CANNOT scan: read the wallet's
 * tracked PT balances and REPLACE its rows for `chainId` in proj_balances (the
 * same transactional per-chain replace as the Khalani / local paths). Fail-soft
 * on RPC/API (skip the write, keep last-good rows); DB read + write PROPAGATE.
 */
export async function seedPendleChainBalances(
  family: ChainFamily,
  walletAddress: string,
  chainId: number,
): Promise<PendleSeedResult> {
  const rows = await collectPendlePtRows(family, walletAddress, chainId);
  if (rows === null) {
    // Non-Pendle chain, nothing tracked, or a soft RPC/API failure — never touch
    // the last-good rows (an empty replace would delete cached PT balances).
    return { chainId, tokensUpdated: 0, skipped: true };
  }
  // `rows` may be [] → replace with empty to clear a stale PT row (post-sell).
  const count = await balancesRepo.replaceBalancesForChain(walletAddress, chainId, rows);
  return { chainId, tokensUpdated: count, skipped: false };
}

/**
 * Dedup-by-address merge. A Pendle-priced row wins over an unpriced Khalani row;
 * a Khalani row that already has a price wins over the Pendle row. Exported for
 * focused unit tests.
 */
export function mergePendleRows(khalaniRows: BalanceRow[], pendleRows: BalanceRow[]): BalanceRow[] {
  const byLower = new Map<string, BalanceRow>();
  for (const row of khalaniRows) byLower.set(row.tokenAddress.toLowerCase(), row);
  for (const pendle of pendleRows) {
    const key = pendle.tokenAddress.toLowerCase();
    const existing = byLower.get(key);
    if (!existing) {
      byLower.set(key, pendle);
      continue;
    }
    // Khalani row with a price is authoritative; otherwise the Pendle-priced row wins.
    if (existing.priceUsd === null && pendle.priceUsd !== null) {
      byLower.set(key, pendle);
    }
  }
  return [...byLower.values()];
}
