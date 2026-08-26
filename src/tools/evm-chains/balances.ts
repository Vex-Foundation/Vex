/**
 * Direct-RPC balance reads for LOCAL (non-Khalani) EVM chains — the single
 * live-read implementation shared by the background sync
 * (`vex-agent/sync/local-chain-balance-sync.ts`) and the agent-facing
 * `WalletBalances` tool (`vex-agent/tools/internal/wallet/read.ts`).
 *
 * Reads batch through the canonical Multicall3; USD prices come from
 * DexScreener (the same throttled client the market tools use). A wanted token
 * is priced from EITHER pair side: a baseToken match uses `priceUsd` directly;
 * a quoteToken match derives USD-per-quote as `priceUsd / priceNative`
 * (`priceNative` is the base price expressed in the quote token). The quote
 * side matters on thin new chains — on the live robinhood index the wrapped
 * native (WETH) appears ONLY as a quote token, so base-only matching left
 * native ETH permanently unpriced. A token without a price keeps its balance
 * with a null USD value — it is never dropped.
 *
 * This module is RPC/pricing only: no DB access, no fail-soft policy. RPC and
 * pricing errors PROPAGATE (DexScreener failures excepted — pricing is
 * fail-soft to an empty map); callers own their failure semantics.
 */

import { getAddress, type Chain, type PublicClient, type Transport } from "viem";

import { readTokensPairs } from "../dexscreener/price-read.js";
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
  const priceByLower = await fetchPricesByLowerAddress(config, tokenAddrs);

  const wrappedNativeLower = config.seedTokens
    .find((token) => token.label.toUpperCase() === `W${config.nativeCurrency.symbol.toUpperCase()}`)
    ?.address.toLowerCase();
  const nativePriceUsd = wrappedNativeLower ? priceByLower.get(wrappedNativeLower) ?? null : null;

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

  return { nativeWei, nativePriceUsd, tokens, tokenFailures };
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

/**
 * Best-liquidity DexScreener USD price per token (lowercase address → price).
 * See the module doc for the base-vs-quote-side pricing rule. Fail-soft: any
 * error (incl. a chain slug DexScreener doesn't index) yields an empty map,
 * and priceless tokens simply keep a null USD value downstream.
 */
async function fetchPricesByLowerAddress(
  config: LocalChainConfig,
  tokenAddrs: readonly `0x${string}`[],
): Promise<Map<string, number>> {
  const priceByLower = new Map<string, number>();
  if (tokenAddrs.length === 0) return priceByLower;

  const wanted = new Set(tokenAddrs.map((address) => address.toLowerCase()));
  // Track the deepest liquidity seen per token so the chosen price is the
  // best-liquidity venue rather than an arbitrary pair (both sides compete
  // through the same comparison — the deepest pool wins regardless of side).
  const bestLiquidity = new Map<string, number>();
  const consider = (lower: string, price: number, liquidity: number): void => {
    if (!Number.isFinite(price) || price < 0) return;
    if (!priceByLower.has(lower) || liquidity > (bestLiquidity.get(lower) ?? -Infinity)) {
      priceByLower.set(lower, price);
      bestLiquidity.set(lower, liquidity);
    }
  };

  for (let i = 0; i < tokenAddrs.length; i += DEXSCREENER_TOKENS_BATCH) {
    const batch = tokenAddrs.slice(i, i + DEXSCREENER_TOKENS_BATCH);
    try {
      const pairs = await readTokensPairs(config.dexscreenerSlug, batch.join(","));
      for (const pair of pairs) {
        if (pair.priceUsd == null) continue;
        const priceUsd = Number(pair.priceUsd);
        if (!Number.isFinite(priceUsd) || priceUsd < 0) continue;
        const liquidity = pair.liquidity?.usd ?? 0;

        const base = pair.baseToken?.address?.toLowerCase();
        if (base && wanted.has(base)) consider(base, priceUsd, liquidity);

        const quote = pair.quoteToken?.address?.toLowerCase();
        if (quote && wanted.has(quote)) {
          const priceNative = Number(pair.priceNative);
          if (Number.isFinite(priceNative) && priceNative > 0) {
            consider(quote, priceUsd / priceNative, liquidity);
          }
        }
      }
    } catch (err) {
      logger.debug("evm_chains.balances.price_batch_failed", {
        slug: config.dexscreenerSlug,
        error: err instanceof Error ? err.name : "unknown",
      });
    }
  }
  return priceByLower;
}

/** Test-only: clear the in-process metadata cache. */
export function resetLocalChainMetadataCache(): void {
  metadataCache.clear();
}
