/**
 * Direct-RPC balance reads for LOCAL (non-Khalani) EVM chains — the single
 * live-read implementation shared by the background sync
 * (`vex-agent/sync/local-chain-balance-sync.ts`) and the agent-facing
 * `WalletBalances` tool (`vex-agent/tools/internal/wallet/read.ts`).
 *
 * Reads batch through the canonical Multicall3; USD prices come from
 * DexScreener through the shared QUOTE-TIERED rule
 * (`dexscreener/best-liquidity-price.ts`) with this chain's own
 * `quoteAssetPolicy`. Only a pool quoted in a stablecoin we recognise (tier 0)
 * or in the chain's wrapped native (tier 1) may price a token, and only above
 * the shared liquidity floor; among those the DEEPEST pool wins whichever class
 * it is. Anything quoted in something else prices nothing at any depth, because
 * provider depth denominated in an asset the provider itself misprices is not
 * evidence. A token left unpriced by the
 * representative pool list gets ONE extra full-pool-list read
 * (`dexscreener/unpriced-pool-fallback.ts`) - measured 2026-08-26, $VEX's
 * representative pool on robinhood is VEX/VIRTUAL (tier 2) while its
 * full pool list carries VEX/USDG at $0.002747. A token still without a price
 * keeps its balance with a null USD value - it is never dropped.
 *
 * The chain's WRAPPED NATIVE is always seeded into the pricing request, whether
 * or not the wallet holds it: it is the anchor every tier-1 price is multiplied
 * by and the only source of the native coin's own USD value. It rides in a
 * batch that is issued anyway, is never counted in the tier census, and never
 * consumes one of the pool-list rescue slots, which belong to the scan set.
 *
 * This module is RPC/pricing only: no DB access, no fail-soft policy. RPC and
 * pricing errors PROPAGATE (DexScreener failures excepted — pricing is
 * fail-soft to an empty map); callers own their failure semantics.
 */

import { getAddress, type Chain, type PublicClient, type Transport } from "viem";

import {
  createBestLiquidityPriceAccumulator,
  summarizeUnpricedReasons,
  type PriceTierCounts,
} from "../dexscreener/best-liquidity-price.js";
import { readTokensPairs } from "../dexscreener/price-read.js";
import { addPoolListsForUnpricedAddresses } from "../dexscreener/unpriced-pool-fallback.js";
import { ERC20_READ_ABI } from "./erc20-reads.js";
import { getLocalPublicClient } from "./evm-client.js";
import type { LocalChainConfig } from "./registry.js";
import logger from "../../utils/logger.js";

/** DexScreener tokens/v1 caps at 30 addresses per request. */
const DEXSCREENER_TOKENS_BATCH = 30;

interface TokenMeta {
  decimals: number;
  symbol: string;
}

/**
 * In-process metadata cache keyed by `${chainId}:${lowercaseAddress}`. ERC-20
 * decimals/symbol are immutable, so caching avoids re-reading them every cycle.
 */
const metadataCache = new Map<string, TokenMeta>();

/** One successfully-read, non-zero ERC-20 holding on a local chain. */
export interface LocalChainTokenRead {
  /** Checksummed token contract address. */
  address: `0x${string}`;
  symbol: string;
  decimals: number;
  balanceWei: bigint;
  priceUsd: number | null;
}

/**
 * One scanned token whose read did NOT produce an answer. Reported separately
 * from `tokens` because "the read failed" and "the balance is zero" are
 * different facts: `multicall({ allowFailure: true })` answers per contract, so
 * a single token can fail while the rest succeed, and a caller that replaces a
 * whole-chain snapshot from the survivors would DELETE a real holding.
 */
export interface LocalChainTokenReadFailure {
  address: `0x${string}`;
  reason: "balance-read-failed" | "metadata-read-failed";
}

export interface LocalChainBalancesRead {
  nativeWei: bigint;
  /** Rides on the wrapped-native seed token's DexScreener price (ETH ≈ WETH). */
  nativePriceUsd: number | null;
  /**
   * Non-zero ERC-20 holdings only (Khalani parity: zero balances are skipped).
   * Tokens that could not be read are NOT here; they are in `tokenFailures`.
   */
  tokens: LocalChainTokenRead[];
  /**
   * Per-token read failures, never conflated with a zero balance. A metadata
   * failure is only reported for a token that HAS a non-zero balance: a zero
   * balance produces no row either way, so its missing decimals lose nothing.
   */
  tokenFailures: LocalChainTokenReadFailure[];
  /**
   * Which quote tier priced each scanned token, and how many stayed unpriced.
   * Public prices only - never a secret - and the sync logs it so a wrong
   * portfolio number can be traced to the rule that produced it.
   */
  priceTiers: PriceTierCounts;
}

/**
 * Read native + ERC-20 balances for one wallet on one local chain, priced via
 * DexScreener. `tokenAddrs` is the caller's scan set (checksummed, deduped —
 * see `buildTokenScanSet` on the sync side). Address-only — never touches key
 * material. RPC errors propagate; pricing is fail-soft (null USD downstream).
 */
export async function readLocalChainBalances(
  config: LocalChainConfig,
  walletAddress: string,
  tokenAddrs: readonly `0x${string}`[],
): Promise<LocalChainBalancesRead> {
  const client = getLocalPublicClient(config);
  const meta = await loadTokenMetadata(client, config.id, tokenAddrs);
  const balances = await readErc20Balances(client, walletAddress, tokenAddrs);
  const nativeWei = await client.getBalance({ address: getAddress(walletAddress) });
  const { priceByLower, tiers, nativeUsd } = await fetchPricesByLowerAddress(config, tokenAddrs);

  // The wrapped native IS the chain's native coin for pricing purposes, and the
  // quote policy already names it - no label-matching heuristic needed. The
  // pricing pass always seeds it into the request, so this is answerable even
  // when the wallet holds no wrapped native at all.
  const nativePriceUsd = nativeUsd;


  const tokens: LocalChainTokenRead[] = [];
  const tokenFailures: LocalChainTokenReadFailure[] = [];
  for (const address of tokenAddrs) {
    const lower = address.toLowerCase();
    const balance = balances.get(lower);
    const tokenMeta = meta.get(lower);
    if (balance === undefined) {
      tokenFailures.push({ address, reason: "balance-read-failed" });
      continue;
    }
    if (balance === 0n) continue;
    if (!tokenMeta) {
      tokenFailures.push({ address, reason: "metadata-read-failed" });
      continue;
    }
    tokens.push({
      address,
      symbol: tokenMeta.symbol,
      decimals: tokenMeta.decimals,
      balanceWei: balance,
      priceUsd: priceByLower.get(lower) ?? null,
    });
  }

  return { nativeWei, nativePriceUsd, tokens, tokenFailures, priceTiers: tiers };
}

// ── On-chain reads ──────────────────────────────────────────────────

async function loadTokenMetadata(
  client: PublicClient<Transport, Chain>,
  chainId: number,
  tokenAddrs: readonly `0x${string}`[],
): Promise<Map<string, TokenMeta>> {
  const result = new Map<string, TokenMeta>();
  const missing: `0x${string}`[] = [];
  for (const address of tokenAddrs) {
    const cached = metadataCache.get(`${chainId}:${address.toLowerCase()}`);
    if (cached) result.set(address.toLowerCase(), cached);
    else missing.push(address);
  }
  if (missing.length === 0) return result;

  const contracts = missing.flatMap((address) => [
    { address, abi: ERC20_READ_ABI, functionName: "decimals" } as const,
    { address, abi: ERC20_READ_ABI, functionName: "symbol" } as const,
  ]);
  const reads = await client.multicall({ allowFailure: true, contracts });

  for (let i = 0; i < missing.length; i++) {
    const address = missing[i]!;
    const decimalsRead = reads[i * 2];
    const symbolRead = reads[i * 2 + 1];
    if (decimalsRead?.status !== "success" || symbolRead?.status !== "success") continue;
    const meta: TokenMeta = {
      decimals: Number(decimalsRead.result),
      symbol: String(symbolRead.result),
    };
    metadataCache.set(`${chainId}:${address.toLowerCase()}`, meta);
    result.set(address.toLowerCase(), meta);
  }
  return result;
}

/** Map lowercase token address → balance (wei) for reads that succeeded. */
async function readErc20Balances(
  client: PublicClient<Transport, Chain>,
  walletAddress: string,
  tokenAddrs: readonly `0x${string}`[],
): Promise<Map<string, bigint>> {
  const result = new Map<string, bigint>();
  if (tokenAddrs.length === 0) return result;
  const owner = getAddress(walletAddress);
  const contracts = tokenAddrs.map(
    (address) => ({ address, abi: ERC20_READ_ABI, functionName: "balanceOf", args: [owner] }) as const,
  );
  const reads = await client.multicall({ allowFailure: true, contracts });
  for (let i = 0; i < tokenAddrs.length; i++) {
    const read = reads[i];
    if (read?.status === "success") {
      result.set(tokenAddrs[i]!.toLowerCase(), read.result as bigint);
    }
  }
  return result;
}

// ── Pricing ─────────────────────────────────────────────────────────

/** What one pricing pass produced: the map plus why, for the sync log. */
interface LocalChainPricing {
  /** Lowercase token address -> USD price. Absent means unpriced. */
  readonly priceByLower: Map<string, number>;
  readonly tiers: PriceTierCounts;
  /**
   * The chain's native USD price, from the wrapped native the request always
   * seeds. Null when no pool in this pass supplied one. It is NOT read out of
   * `priceByLower`: the wrapped native only has an entry there when the wallet
   * happens to hold it.
   */
  readonly nativeUsd: number | null;
}

/**
 * Quote-tiered DexScreener USD price per token (lowercase address -> price).
 *
 * The selection rule itself (quote tiers, deepest-pool tie-break WITHIN a tier,
 * nativeUsd derivation, accumulated ACROSS batches) lives in
 * `dexscreener/best-liquidity-price.ts`, shared with the Solana wallet read;
 * this function owns only the batching, the chain slug, the chain's quote
 * policy and the fail-soft policy: any error (incl. a chain slug DexScreener
 * doesn't index) leaves those addresses unpriced, and priceless tokens simply
 * keep a null USD value downstream.
 */
async function fetchPricesByLowerAddress(
  config: LocalChainConfig,
  tokenAddrs: readonly `0x${string}`[],
): Promise<LocalChainPricing> {
  const accumulator = createBestLiquidityPriceAccumulator({
    // EVM addresses are case-insensitive, so the injected identity policy is
    // lowercase and the returned map is keyed by lowercase address, exactly as
    // every caller of this function already reads it.
    //
    // COVERAGE SET, deliberately NOT the request set below: `countTiers()`
    // counts these addresses, so the wrapped-native seed must not enter here or
    // every census would gain a token this wallet does not hold.
    wanted: tokenAddrs,
    normalizeAddress: (address) => address.toLowerCase(),
    quotePolicy: config.quoteAssetPolicy,
    expectedChainId: config.dexscreenerSlug,
  });

  // REQUEST set: the scanned tokens PLUS this chain's wrapped native, always.
  // The wrapped native anchors `nativeUsd`, and without it in the request every
  // tier-1 token on a scan set that happens to exclude it is unpriceable and the
  // chain's own native coin has no price at all. It rides along in a batch that
  // is issued anyway; it never consumes a rescue slot (the rescue pass below
  // reads the scan set) and never appears in the tier census.
  const wrappedNative = config.quoteAssetPolicy.wrappedNative.toLowerCase();
  const pricingAddresses = [
    ...tokenAddrs,
    ...(tokenAddrs.some((address) => address.toLowerCase() === wrappedNative)
      ? []
      : [wrappedNative]),
  ];
  // An EMPTY scan set still issues this one request: the wallet's native coin
  // is reported by this reader whether or not it holds any ERC-20, and its
  // price comes from the wrapped native alone. Pricing nothing is what used to
  // leave a native-only wallet with a null USD value.
  for (let i = 0; i < pricingAddresses.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = pricingAddresses.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    try {
      accumulator.addPairs(await readTokensPairs(config.dexscreenerSlug, batch.join(",")));
    } catch (err) {
      logger.debug("evm_chains.balances.price_batch_failed", {
        slug: config.dexscreenerSlug,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }

  // Second, bounded pass: the provider's representative pool for a token can be
  // the very tier-2 pool the rule refuses to price from, while the token's full
  // pool list carries a tier-0 one.
  const fallback = await addPoolListsForUnpricedAddresses(
    { accumulator, chainSlug: config.dexscreenerSlug, addresses: tokenAddrs },
    (address) => address.toLowerCase(),
    (address, err) => {
      logger.debug("evm_chains.balances.pool_fallback_failed", {
        slug: config.dexscreenerSlug,
        token: address,
        error: err instanceof Error ? err.name : "unknown",
      });
    },
  );
  if (fallback.attempted > 0 || fallback.skipped > 0) {
    logger.debug("evm_chains.balances.pool_fallback", {
      slug: config.dexscreenerSlug,
      ...fallback,
    });
  }

  const foreignChainPairs = accumulator.foreignChainPairsRefused();
  if (foreignChainPairs > 0) {
    logger.warn("evm_chains.balances.foreign_chain_pairs_refused", {
      slug: config.dexscreenerSlug,
      pairs: foreignChainPairs,
    });
  }

  const tiers = accumulator.countTiers();
  if (tiers.unpriced > 0) {
    logger.debug("evm_chains.balances.unpriced_reasons", {
      slug: config.dexscreenerSlug,
      ...summarizeUnpricedReasons(accumulator),
    });
  }
  return { priceByLower: accumulator.toPriceMap(), tiers, nativeUsd: accumulator.nativeUsd() };
}

/** Test-only: clear the in-process metadata cache. */
export function resetLocalChainMetadataCache(): void {
  metadataCache.clear();
}
