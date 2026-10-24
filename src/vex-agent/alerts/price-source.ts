/**
 * Prices for the watchlist, the alert service and the alert poller (F01).
 *
 * The SAME price the `token_price` wake watch acts on: `readTokenPools` (the
 * keyless DexScreener public read, shared bucket and 30 s cache) plus
 * `selectTokenWatchPrice` (normalise every pool to the token, drop outliers,
 * take the deepest). No key, no vault, no signer: it works while locked.
 *
 * 24 HOUR CHANGE. Only when the chosen pool holds the token on its BASE side.
 * On a quote-side pool DexScreener's `priceChange.h24` belongs to the other
 * token, so it is reported as unknown rather than shown wrong.
 *
 * One read per distinct (chain, address). A failed read is reported in
 * `failed` and never thrown: the page shows "no price" for that row, and the
 * poller ends its tick and tries again.
 */

import { readTokenPools } from "../../tools/dexscreener/price-read.js";
import { selectTokenWatchPrice, type BoundedDecimal } from "../../tools/dexscreener/token-watch-price.js";
import type { DexPair } from "../../tools/dexscreener/types.js";
import { familyForSlug } from "../engine/wake/watch/token-price/chain-domain.js";

/** Bound on one provider read, so a page refresh or a poll tick cannot hang. */
export const PRICE_READ_TIMEOUT_MS = 5_000;

/** Longest symbol kept from the provider; display code sanitises it further. */
export const SYMBOL_MAX_CHARS = 32;

export interface PriceAsset {
  /** The canonical DexScreener slug (`resolveWatchChain`). */
  readonly chain: string;
  /** The stored spelling (`normalizeAddressForFamily`). */
  readonly address: string;
}

export interface TokenQuote {
  readonly assetKey: string;
  /** Exact decimal string, plain notation. */
  readonly priceUsd: string;
  readonly price: BoundedDecimal;
  /** Percent over 24 hours, or `null` when the pool cannot say it for this token. */
  readonly change24hPct: number | null;
  readonly pairAddress: string;
  readonly dexId: string;
  /** The pool's symbol for this token, bounded, or `null`. */
  readonly symbol: string | null;
}

export interface PriceTokensResult {
  readonly quotes: ReadonlyMap<string, TokenQuote>;
  /** Asset keys whose read failed (network, timeout, provider error). */
  readonly failed: readonly string[];
}

export type ReadPools = (chain: string, address: string, options: { timeoutMs: number; signal?: AbortSignal }) => Promise<DexPair[]>;

export interface PriceTokensOptions {
  readonly signal?: AbortSignal;
  /** Injected in tests; defaults to the shared DexScreener public read. */
  readonly readPools?: ReadPools;
}

export function assetKeyOf(asset: PriceAsset): string {
  return `${asset.chain}:${asset.address}`;
}

function boundedSymbol(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Control characters never reach a label; the renderer sanitises the rest.
  const cleaned = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0) return null;
  return cleaned.slice(0, SYMBOL_MAX_CHARS);
}

/** Price one token from its pool list, or `null` when no pool is one we act on. */
export function quoteFromPools(asset: PriceAsset, pairs: readonly DexPair[]): TokenQuote | null {
  const family = familyForSlug(asset.chain);
  const selected = selectTokenWatchPrice(pairs, {
    chainSlug: asset.chain,
    tokenAddress: asset.address,
    caseSensitiveAddress: family === "solana",
  });
  if (selected === null) return null;
  const pool = pairs.find((pair) => pair.pairAddress === selected.pairAddress);
  const change = selected.side === "base" ? pool?.priceChange?.["h24"] : undefined;
  const token = selected.side === "base" ? pool?.baseToken : pool?.quoteToken;
  return {
    assetKey: assetKeyOf(asset),
    priceUsd: selected.priceUsd,
    price: selected.price,
    change24hPct: typeof change === "number" && Number.isFinite(change) ? change : null,
    pairAddress: selected.pairAddress,
    dexId: selected.dexId,
    symbol: boundedSymbol(token?.symbol),
  };
}

const defaultReadPools: ReadPools = (chain, address, options) => readTokenPools(chain, address, options);

/**
 * Price every distinct asset once. Unpriced tokens are simply absent from
 * `quotes`; failed reads are listed in `failed`.
 */
export async function priceTokens(
  assets: readonly PriceAsset[],
  options: PriceTokensOptions = {},
): Promise<PriceTokensResult> {
  const readPools = options.readPools ?? defaultReadPools;
  const distinct = new Map<string, PriceAsset>();
  for (const asset of assets) distinct.set(assetKeyOf(asset), asset);
  const keys = [...distinct.keys()].sort();

  const quotes = new Map<string, TokenQuote>();
  const failed: string[] = [];
  await Promise.all(keys.map(async (key) => {
    const asset = distinct.get(key);
    if (asset === undefined) return;
    try {
      const pairs = await readPools(asset.chain, asset.address, {
        timeoutMs: PRICE_READ_TIMEOUT_MS,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const quote = quoteFromPools(asset, pairs);
      if (quote !== null) quotes.set(key, quote);
    } catch {
      failed.push(key);
    }
  }));
  failed.sort();
  return { quotes, failed };
}
