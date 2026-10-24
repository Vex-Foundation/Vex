/**
 * Token search for the Watchlist's add form: a ticker or name typed on one
 * chain, answered from DexScreener.
 *
 * TWO SOURCES, ONE ANSWER SHAPE. The site search (`searchPairs`) narrows by
 * chain on the provider, so "PEPE" on base returns base pools only; it needs
 * the site bridge, which lives in the Electron main process. When that bridge
 * is not up, the public JSON search (`readSearchPairs`) answers instead: it
 * takes no chain filter, so its 30-pair window is filtered here, and a busy
 * ticker on another chain can leave few rows for the chosen one. The answer
 * says which source spoke.
 *
 * One entry per token, its pools summed. Tokens rank by 24 hour volume, then
 * pool count, then liquidity, NOT by liquidity alone: measured 2026-10-24 on
 * "BONK" on solana, two copycat "Bonk Coin" tokens reported $50M and $23M of
 * liquidity in one pool each with $2 of daily volume, while the real BONK had
 * eleven pools and $698k of volume. A reported liquidity figure is cheap to
 * inflate; trading is not. Each hit carries its pool count and volume so the
 * page can show them. Only tokens whose ticker or name contains the query, or
 * whose address is the query, are kept: a USDC pool that matched on its other
 * side must not offer USDC.
 *
 * Read only and keyless. Nothing here is stored.
 */

import { searchPairs, SEARCH_MIN_QUERY_LENGTH } from "@tools/dexscreener/endpoints/search.js";
import { readSearchPairs } from "@tools/dexscreener/price-read.js";
import { projectPairRow } from "@tools/dexscreener/screen-core/project.js";
import { getDexScreenerTransport, type DexScreenerTransport } from "@tools/dexscreener/transport.js";
import type { DexPair } from "@tools/dexscreener/types.js";
import { resolveWatchChain } from "../engine/wake/watch/token-price/chain-domain.js";
import logger from "@utils/logger.js";

/** At most this many tokens come back, deepest liquidity first. */
export const TOKEN_SEARCH_RESULT_LIMIT = 12;
/** Longest query the form may send. */
export const TOKEN_SEARCH_QUERY_MAX = 64;
const SEARCH_TIMEOUT_MS = 8_000;

export type TokenSearchSource = "chain_search" | "public_search";

export interface TokenSearchHit {
  readonly address: string;
  readonly symbol: string;
  readonly name: string | null;
  readonly priceUsd: string | null;
  /** Summed over the token's pools in this answer. */
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly poolCount: number;
  /** The token's busiest pool in this answer, which `priceUsd` comes from. */
  readonly dexId: string;
  readonly pairAddress: string;
}

export type TokenSearchResult =
  | {
      readonly ok: true;
      readonly chain: string;
      readonly query: string;
      readonly source: TokenSearchSource;
      readonly tokens: readonly TokenSearchHit[];
    }
  | {
      readonly ok: false;
      readonly reason: "unsupported_chain" | "invalid_query" | "search_unavailable";
      readonly message: string;
    };

/** One pair, reduced to what the token list reads; both sources map into it. */
export interface CandidatePair {
  readonly chainId: string;
  readonly dexId: string;
  readonly pairAddress: string;
  readonly priceUsd: string | null;
  readonly liquidityUsd: number | null;
  readonly volume24hUsd: number | null;
  readonly base: CandidateToken;
  readonly quote: CandidateToken;
}

interface CandidateToken {
  readonly address: string | null;
  readonly symbol: string | null;
  readonly name: string | null;
}

export interface TokenSearchDeps {
  readonly transport: () => DexScreenerTransport;
  readonly chainSearch: typeof searchPairs;
  readonly publicSearch: typeof readSearchPairs;
  readonly now: () => number;
}

const DEFAULT_DEPS: TokenSearchDeps = {
  transport: getDexScreenerTransport,
  chainSearch: searchPairs,
  publicSearch: readSearchPairs,
  now: Date.now,
};

export async function searchAlertTokens(
  input: { readonly chain: string; readonly query: string; readonly signal?: AbortSignal },
  deps: TokenSearchDeps = DEFAULT_DEPS,
): Promise<TokenSearchResult> {
  const chain = resolveWatchChain(input.chain);
  if (chain === null) {
    return { ok: false, reason: "unsupported_chain", message: `Vex does not watch prices on ${input.chain}.` };
  }
  const query = input.query.trim();
  // A double quote makes the site search answer an empty body, read as
  // "nothing matches"; refuse it rather than show a false empty list.
  if (query.length < SEARCH_MIN_QUERY_LENGTH || query.length > TOKEN_SEARCH_QUERY_MAX || query.includes('"')) {
    return {
      ok: false,
      reason: "invalid_query",
      message: `Type ${SEARCH_MIN_QUERY_LENGTH} to ${TOKEN_SEARCH_QUERY_MAX} characters of a ticker, a name or an address.`,
    };
  }
  const signal = input.signal === undefined ? {} : { signal: input.signal };

  try {
    const result = await deps.chainSearch({
      query,
      chainIds: [chain.slug],
      transport: deps.transport(),
      timeoutMs: SEARCH_TIMEOUT_MS,
      ...signal,
    });
    const nowMs = deps.now();
    const pairs = result.rows.flatMap((row) => {
      const pair = fromSiteRow(row, nowMs);
      return pair === null ? [] : [pair];
    });
    return { ok: true, chain: chain.slug, query, source: "chain_search", tokens: tokensFromPairs(pairs, query, chain.slug) };
  } catch (error) {
    logger.info("alerts.token_search.chain_search_unavailable", {
      chain: chain.slug,
      error: error instanceof Error ? error.name : "unknown",
    });
  }

  try {
    const result = await deps.publicSearch(query, { timeoutMs: SEARCH_TIMEOUT_MS, ...signal });
    const pairs = result.pairs.map(fromPublicPair);
    return { ok: true, chain: chain.slug, query, source: "public_search", tokens: tokensFromPairs(pairs, query, chain.slug) };
  } catch (error) {
    logger.warn("alerts.token_search.failed", { chain: chain.slug, error: error instanceof Error ? error.name : "unknown" });
    return {
      ok: false,
      reason: "search_unavailable",
      message: "Token search is not answering right now. Paste the token address instead.",
    };
  }
}

function fromSiteRow(row: unknown, nowMs: number): CandidatePair | null {
  try {
    const projected = projectPairRow(row, { window: "h24", nowMs });
    return {
      chainId: projected.chainId,
      dexId: projected.dexId,
      pairAddress: projected.pairAddress,
      priceUsd: projected.priceUsd,
      liquidityUsd: projected.liquidityUsd,
      volume24hUsd: projected.volumeUsd,
      base: projected.baseToken,
      quote: projected.quoteToken,
    };
  } catch {
    return null;
  }
}

function fromPublicPair(pair: DexPair): CandidatePair {
  return {
    chainId: pair.chainId,
    dexId: pair.dexId,
    pairAddress: pair.pairAddress,
    priceUsd: pair.priceUsd,
    liquidityUsd: pair.liquidity?.usd ?? null,
    volume24hUsd: pair.volume["h24"] ?? null,
    base: { address: pair.baseToken.address, symbol: pair.baseToken.symbol, name: pair.baseToken.name },
    quote: { address: pair.quoteToken.address, symbol: pair.quoteToken.symbol, name: pair.quoteToken.name },
  };
}

/** One hit per token on `chain`, its pools summed, matching tokens only, busiest first. */
export function tokensFromPairs(pairs: readonly CandidatePair[], query: string, chain: string): TokenSearchHit[] {
  const needle = query.toLowerCase();
  const byToken = new Map<string, { hit: TokenSearchHit; busiest: number }>();
  for (const pair of pairs) {
    if (pair.chainId !== chain) continue;
    for (const side of ["base", "quote"] as const) {
      const token = pair[side];
      const symbol = token.symbol?.trim() ?? "";
      const name = token.name?.trim() || null;
      if (token.address === null || symbol === "") continue;
      const matches =
        token.address.toLowerCase() === needle ||
        symbol.toLowerCase().includes(needle) ||
        (name !== null && name.toLowerCase().includes(needle));
      if (!matches) continue;
      // The pair's USD price is the BASE token's; a quote-side match has no
      // price of its own in this row.
      const priceUsd = side === "base" ? pair.priceUsd : null;
      const volume = pair.volume24hUsd ?? 0;
      const key = token.address.toLowerCase();
      const held = byToken.get(key);
      if (held === undefined) {
        byToken.set(key, {
          busiest: volume,
          hit: {
            address: token.address,
            symbol: symbol.slice(0, 32),
            name: name === null ? null : name.slice(0, 80),
            priceUsd,
            liquidityUsd: pair.liquidityUsd,
            volume24hUsd: pair.volume24hUsd,
            poolCount: 1,
            dexId: pair.dexId,
            pairAddress: pair.pairAddress,
          },
        });
        continue;
      }
      const busier = volume > held.busiest && priceUsd !== null;
      byToken.set(key, {
        busiest: busier ? volume : held.busiest,
        hit: {
          ...held.hit,
          ...(busier || held.hit.priceUsd === null ? { priceUsd: priceUsd ?? held.hit.priceUsd } : {}),
          ...(busier ? { dexId: pair.dexId, pairAddress: pair.pairAddress } : {}),
          liquidityUsd: sum(held.hit.liquidityUsd, pair.liquidityUsd),
          volume24hUsd: sum(held.hit.volume24hUsd, pair.volume24hUsd),
          poolCount: held.hit.poolCount + 1,
        },
      });
    }
  }
  return [...byToken.values()]
    .map((entry) => entry.hit)
    .sort(
      (a, b) =>
        (b.volume24hUsd ?? -1) - (a.volume24hUsd ?? -1) ||
        b.poolCount - a.poolCount ||
        (b.liquidityUsd ?? -1) - (a.liquidityUsd ?? -1),
    )
    .slice(0, TOKEN_SEARCH_RESULT_LIMIT);
}

function sum(a: number | null, b: number | null): number | null {
  return a === null && b === null ? null : (a ?? 0) + (b ?? 0);
}
