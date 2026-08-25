/**
 * The v2 token-grouped screener channel client.
 *
 * `wss://io.dexscreener.com/dex/screener/v2/tokens/{tf}/{page}?{qs}`
 *
 * Same channel mechanics as the pair screener (same oneof, same frame-order
 * hazard, same query grammar), one row per BASE TOKEN per page instead of one
 * per pool.
 *
 * WHAT A ROW ON THIS CHANNEL ACTUALLY IS, measured, because the previous
 * reading ("one row per base token, deduplicated by the provider") is false in
 * three separate ways and each one produces a wrong answer:
 *
 *  1. THE ROW IS A HYBRID. `volume`, `liquidity`, `txns` and the
 *     buyers/sellers/makers counts are SUMS over the token's pools, while
 *     `pairAddress`, `dexId`, `quoteToken`, `price`, `marketCap` and `fdv`
 *     come from ONE representative pool. The same pool carried 2.20x the
 *     liquidity here that it carried on the pairs channel at the same instant
 *     (SOL: 55,101,455 vs 25,048,251; volume 1.75x; 24 h buys 5.6x).
 *  2. THE REPRESENTATIVE POOL'S VALUATION CAN BE ORDERS OF MAGNITUDE WRONG,
 *     because it is that pool's price times supply. JUP was served at
 *     3,659,403,553,911 USD, and re-measured 2026-08-25 at 3,683,346,910,956
 *     with PUMP at 23,984,853,158,508. TRUMP was served at 492 M on one board
 *     and 28,534,917,137 on another in the same minute.
 *  3. THE UNIVERSE IS PROFILE-ONLY. The channel silently serves only tokens
 *     carrying a DexScreener CMS profile (`cmsProfile.iconId` on 100 percent
 *     of 1,072 rows across 15 boards). Of the 173 distinct solana base tokens
 *     whose pools match a 5,000,000 USD 24 h volume floor, this channel
 *     returns 15 and calls page 2 empty; the 158 dropped tokens include NVDA
 *     (216 M USD of 24 h volume), TMX (196 M) and HOOD (109 M).
 *
 * And three facts about traversal:
 *
 *  4. THERE IS NO SERVER TOTAL. `pairsCount` on this channel is the page
 *     length, not the size of the matched set (measured 100 on a full page).
 *     `totalUnavailable` says so, and the count is deliberately not surfaced
 *     as a total anywhere.
 *  5. PAGES REPEAT TOKENS, AND NOT ONLY ADJACENT ONES. Dedup is per 100-row
 *     page only: p1/p2 repeated 17 tokens, p1/p5 17, p1/p10 26 on one board,
 *     and 14 on a fresh p1/p2 re-measurement 2026-08-25. The repeats carry
 *     DISJOINT aggregates and, critically, DIFFERENT `pairAddress` values (0
 *     repeated pair addresses across those same 14 repeated tokens), so a
 *     duplicate counter keyed on the pair address reports zero on a window
 *     that repeated a dozen tokens. Repeat detection on this channel keys on
 *     the BASE TOKEN.
 *  6. THE ORDER IS PROVIDER-OPAQUE. Rank keys select meaningfully different
 *     sets, but the served order is not reproducible from any single visible
 *     metric (48 to 51 order violations of 99 adjacent pairs; position/metric
 *     correlation 0.38 to 0.63). A tool must describe the ordering as the
 *     provider's, not as "by volume".
 */

import {
  fetchScreenerChannelPage,
  type ScreenerPageOptions,
  type ScreenerPageResult,
} from "./screener.js";
import type { ScreenQuery } from "../screen-core/request.js";

/**
 * What the caller must not assume about this channel's answer.
 *
 * Every flag is `true` by construction: these are properties of the CHANNEL,
 * not of one query, so a false value would be a claim nothing measured. Each
 * one carries a note, because a boolean an agent cannot read the reason for is
 * a boolean it will ignore.
 */
export interface TokensChannelHonesty {
  /** The channel publishes no total for the matched set. Always true. */
  readonly totalUnavailable: true;
  /** `pairsCount` is the length of this page. Always true. */
  readonly pairsCountIsPageLength: true;
  /** Pages repeat TOKENS, and not only adjacent pages. Always true. */
  readonly pagesOverlap: true;
  /** The ranking is not reproducible from any visible metric. Always true. */
  readonly orderIsProviderOpaque: true;
  /**
   * The row's volume, liquidity and counts are SUMS over the token's pools,
   * not one pool's numbers. Always true.
   */
  readonly metricsAreTokenAggregates: true;
  /**
   * `marketCapUsd`, `fdvUsd`, `priceUsd`, `pairAddress`, `dexId` and
   * `quoteTokenSymbol` come from ONE representative pool the provider chose,
   * beside aggregate metrics. Always true.
   */
  readonly valuationIsRepresentativePool: true;
  /** The universe is the provider's profile-carrying tokens only. Always true. */
  readonly universeIsProfileOnly: true;
  /**
   * Repeats across pages are counted by BASE TOKEN, because the repeated rows
   * carry different pair addresses. Always the string below.
   */
  readonly repeatsCountedBy: "baseTokenAddress";
  /** The measured sentences behind the flags, in the response, once. */
  readonly notes: readonly string[];
}

/** The channel's honesty facts, as one shared frozen value. */
export const TOKENS_CHANNEL_HONESTY: TokensChannelHonesty = Object.freeze({
  totalUnavailable: true,
  pairsCountIsPageLength: true,
  pagesOverlap: true,
  orderIsProviderOpaque: true,
  metricsAreTokenAggregates: true,
  valuationIsRepresentativePool: true,
  universeIsProfileOnly: true,
  repeatsCountedBy: "baseTokenAddress",
  notes: Object.freeze([
    "Volume, liquidity, transaction counts and buyers/sellers/makers on a row are SUMS across every pool of that token. That aggregation is what this channel is for, and it is why the same pool measured 2.20x the liquidity, 1.75x the volume and 5.6x the 24 h buys here that it measured on the pair channel at the same instant. EACH SUM COVERS THAT ROW'S OWN GROUP OF POOLS, NOT THE TOKEN'S WHOLE POOL SET: when a token recurs across pages its rows partition its pools between them, so the groups are DISJOINT and no single row is the token's total. Measured on PENGU, whose non-JUP pools and whose JUP-quoted pool arrived as two rows, each reading like a complete picture of the token. Add the rows of a repeated token together, or read the pair screening tools, before quoting a token-wide figure.",
    "marketCap, fdv, price, pairAddress, dexId and quoteTokenSymbol are the REPRESENTATIVE POOL's, not the token's, and the valuation can be wrong by orders of magnitude: JUP was served at 3,659,403,553,911 USD and PUMP at 23,984,853,158,508. Use the pair screening tools for a valuation you intend to quote.",
    "Coverage is the provider's profile-carrying tokens only, and nothing in the response would otherwise say so. Of 173 distinct solana base tokens whose pools clear 5,000,000 USD of 24 h volume, this channel returns 15 and reports the next page empty; NVDA, TMX and HOOD were among the tokens dropped. A short board here is not evidence that the market is short.",
    "The same token recurs on later pages with disjoint aggregates and a different representative pool, so duplicateRowsAcrossPages counts BASE TOKENS here. Measured: pages 1 and 2 repeated 17 tokens carrying 0 repeated pair addresses, and 14 on a re-measurement.",
  ] as readonly string[]),
});

export interface TokensPageResult extends ScreenerPageResult {
  readonly honesty: TokensChannelHonesty;
}

/**
 * Fetch one page of the v2 token-grouped screener channel.
 *
 * The result is the pair-channel result plus `honesty`. `frame.pairsCount` is
 * present because the provider sent it, and it is the PAGE LENGTH: a caller
 * that puts it in `totalMatchedApprox` is reporting a number that does not
 * exist.
 */
export async function fetchTokensPage(
  query: ScreenQuery,
  options: ScreenerPageOptions
): Promise<TokensPageResult> {
  const result = await fetchScreenerChannelPage(
    "/dex/screener/v2/tokens",
    "dex_screener.TokensChannelMessage",
    query,
    options
  );
  return { ...result, honesty: TOKENS_CHANNEL_HONESTY };
}
