import type { ProtocolToolManifest } from "../../types.js";
import { DEXSCREENER_CORE_DISCOVERY } from "../../embeddings/dexscreener/core.js";
import {
  PAIR_DESCRIPTION_WINDOW_CLAUSE,
  PAIR_LIST_PARAMS,
  PAIR_LOOKUP_PARAMS,
  SEARCH_CHAIN_FILTER_PARAM,
  SEARCH_LIST_PARAMS,
  SOURCE_OBSERVATION_CLAUSE,
  STRING_OR_ARRAY_CLAUSE,
  TOKENS_BATCH_PARAMS,
} from "./pair-list-params.js";
import { DEXSCREENER_CHAIN_PARAM } from "../chain-param.js";

// Chain slugs are DexScreener string ids: ethereum, base, solana, bsc,
// arbitrum, polygon, avalanche, optimism, robinhood (chain id 4663), and more.
// Typical research flow: search → tokenPairs (pick deepest pool) → pairs (deep
// stats on that pool).
//
// All four tools share the param vocabulary in `./pair-list-params.ts` and the
// output contract in `../pair-list/`. The `description` strings below now carry
// the same honest constraints as the param text: what the provider chose, what
// Vex applied to it, and that neither the window nor the sort can be widened.

export const CORE_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "dexscreener.search",
    publicName: "dexscreener__pairs_search",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Search DEX pairs across every chain by token name, symbol, or contract address. Start here "
      + "when you have a name/ticker/address but not a specific pool. Returns pair identity, base "
      + "price, selected-window change/volume, liquidity, age and labels in provider relevance order; "
      + "FDV, market cap, reserves and per-window transaction counts are opt-in through fields. "
      + "raw priceUsd always prices the pair's base token. The order is what DexScreener returned, "
      + "not a ranking - and the window can EXCLUDE the canonical token entirely (measured: a "
      + "ticker query returned 7 spoofed rows and not the genuine token, whose real symbol "
      + "differed; querying the project NAME found it). A symbol match is never identity: confirm "
      + "with an exact contract address before quoting a price. Returns 5 rows by default; "
      + "filtersApplied.limit and hasMore expose that "
      + "window and offset reads the rest. Optional discovery filters: chainIds (e.g. "
      + "ethereum, base, solana, bsc, arbitrum, robinhood), minLiquidityUsd, limit. "
      + PAIR_DESCRIPTION_WINDOW_CLAUSE
      + " " + SOURCE_OBSERVATION_CLAUSE
      + " Then use dexscreener.tokenPairs to pick the deepest pool.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "query",
        type: "string",
        required: true,
        description:
          "What to match, minimum 2 characters (DexScreener answers 1 character with an HTTP 400 "
          + "it does not explain). Matches a token name (spaces are fine), a symbol, a token "
          + "address, pair notation like SOL/USDC, and a venue name such as raydium — which acts "
          + "as a de-facto venue filter. A POOL address is the cheapest way to identify an address "
          + "of unknown provenance, but it can return matching rows on more than one chain because "
          + "EVM addresses recur — inspect chainId on every returned row or use `chainIds` to "
          + "narrow. TRAP: matching is purely textual and never against the chain field, so "
          + "q=arbitrum returns the ARB token on Solana, not pools on Arbitrum — use `chainIds` "
          + "for that.",
      },
      SEARCH_CHAIN_FILTER_PARAM,
      // The shared vocabulary, with `limit` carrying THIS surface's measured
      // bare-call size — same key, same rules, one extra measured sentence.
      ...SEARCH_LIST_PARAMS,
    ],
    // No minTurnoverRatio here: the description's INVERSION clause warns that a
    // threshold catching impostors can delete the canonical deep pool, and an
    // example teaches harder than prose.
    exampleParams: { query: "PEPE", chainIds: "ethereum", explainDrops: true },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.search"],
  },
  {
    toolId: "dexscreener.pairs",
    publicName: "dexscreener__pairs_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Get concise stats for one specific DEX pool by chain + pair address — identity, base price, "
      + "selected-window price change/volume, liquidity and pair age. FDV, market cap, reserves and "
      + "per-window transaction counts are opt-in through fields. Use "
      + "when you already have a pool address (e.g. from dexscreener.tokenPairs) and want its "
      + "numbers. Raw priceUsd always prices the pair's base token. Direct lookup returns only the "
      + "pool(s) you name (a comma-separated address list "
      + "is fetched in one call). Vex applies no filtering here; DexScreener offers no server-side "
      + "filter or sort. " + SOURCE_OBSERVATION_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [
      DEXSCREENER_CHAIN_PARAM,
      {
        key: "pairAddress",
        type: "string",
        acceptsStringArray: true,
        required: true,
        description:
          "Up to 60 DEX pool/pair contract addresses. Vex deduplicates them, splits them into "
          + "provider-safe calls of at most 30, and merges all responses — cheaper than "
          + `one call each. ${STRING_OR_ARRAY_CLAUSE} `
          + "The reply reconciles every address: requestedPairAddresses, resolvedPairAddresses, "
          + "unresolvedPairAddresses (asked, not returned), unreachedPairAddresses (their batch "
          + "failed - retry those), batchRequestCount, failedBatchCount, and `found`.",
      },
      ...PAIR_LOOKUP_PARAMS,
    ],
    exampleParams: { chain: "ethereum", pairAddress: "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640" },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.pairs"],
  },
  {
    toolId: "dexscreener.tokens",
    publicName: "dexscreener__tokens_get",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "Batch-price up to 60 token addresses on ONE chain. Vex deduplicates addresses, splits them "
      + "into DexScreener's 30-address requests, and merges every completed batch; a failed batch "
      + "is reported per address in unreachedAddresses (never asked - retry) with failedBatchCount, "
      + "distinct from unresolvedAddresses (asked, not returned). Returns 15 pair "
      + "rows by default while keeping complete requested/resolved/unresolved address accounting; "
      + "filtersApplied.limit, hasMore and offset expose the remaining merged rows, and "
      + "sortBy/sortDir order the window (e.g. sortBy: \"liquidityUsd\" for biggest holdings "
      + "first) - a sort only reorders, it never removes a holding. "
      + "Returns one provider-chosen pair snapshot per resolved address. Raw priceUsd always prices "
      + "the pair's base token. DexScreener's batch endpoint is reconciled strictly against that "
      + "baseAddress; use dexscreener.tokenPairs for side-aware normalized requested-token prices. Use this tool for "
      + "portfolio snapshots, comparing several tokens on the same chain, or resolving feed "
      + "candidates in one batch. Optional screeners (requireLiquidityUsd, "
      + "minPairAgeSeconds/maxPairAgeSeconds) drop rows only on request and every drop is counted "
      + "in droppedByFilter - no holding is ever silently filtered out. Pre-graduation "
      + "bonding-curve pools (e.g. pumpfun) legitimately report liquidityUsd: null and "
      + "turnoverRatioH24: null - null means unknown reserves, not zero, and such rows sort last "
      + "under sortBy: \"liquidityUsd\". "
      + SOURCE_OBSERVATION_CLAUSE + " "
      + PAIR_DESCRIPTION_WINDOW_CLAUSE,
    mutating: false,
    actionKind: "read",
    params: [
      DEXSCREENER_CHAIN_PARAM,
      {
        key: "tokenAddresses",
        type: "string",
        acceptsStringArray: true,
        required: true,
        description:
          "Up to 60 comma-separated token addresses. Vex splits them into calls of at most 30, "
          + "then reports batchRequestCount, failedBatchCount and every "
          + "requested/resolved/unresolved/unreached address. "
          + `Always inspect unresolvedAddresses and unreachedAddresses. ${STRING_OR_ARRAY_CLAUSE} `
          + "Address casing is preserved on both spellings (Solana base58 is case-sensitive). Each "
          + "address yields ONE arbitrary pool, often not the deepest; use dexscreener.tokenPairs "
          + "for depth.",
      },
      ...TOKENS_BATCH_PARAMS,
    ],
    exampleParams: { chain: "ethereum", tokenAddresses: "0xA0b86991c6218b36c1d19d4a2e9eb0ce3606eb48,0xdAC17F958D2ee523a2206206994597C13D831ec7" },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.tokens"],
  },
  {
    toolId: "dexscreener.tokenPairs",
    publicName: "dexscreener__token_pairs_list",
    namespace: "dexscreener",
    lifecycle: "active",
    description:
      "List and shortlist the DexScreener-indexed pools for ONE exact token on a chain, sorted by "
      + "USD liquidity within the provider window. This is research, not an executable routing or "
      + "price decision: obtain a fresh quote from the actual venue before trading. Returns concise pair "
      + "rows including pairAddress, requestedTokenSide, and requestedTokenPriceUsd. Raw priceUsd "
      + "always prices the pair's base token; requestedTokenPriceUsd is normalized for the requested "
      + "token whether it appears on the base or quote side. The envelope reports a cross-pool "
      + "sanity check computed over the FULL provider window: "
      + "requestedTokenPriceUsdMedianAcrossPools (the requested token's median price), "
      + "pricePoolOutliers, and per-row priceSanity (ok | outlier_vs_pool_median | unknown; "
      + "unknown means the price could not be proven, never that it is wrong). "
      + SOURCE_OBSERVATION_CLAUSE
      + " Use dexscreener.pairs for a known pool's "
      + "research metrics. Returns 15 sorted rows by default and exposes the rest through hasMore "
      + "and offset. The provider selects at most 30 pools per token, in unspecified order — "
      + "an observed cap, not a documented one - high-pool-count tokens come back truncated with "
      + "no way to widen. Vex then "
      + "sorts that bounded window (by USD liquidity by default) and applies every filter and "
      + "window; no server-side filter, sort, limit or pagination exists.",
    mutating: false,
    actionKind: "read",
    params: [
      DEXSCREENER_CHAIN_PARAM,
      { key: "tokenAddress", type: "string", required: true, description: "Token contract address." },
      ...PAIR_LIST_PARAMS,
    ],
    exampleParams: { chain: "solana", tokenAddress: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" },
    discovery: DEXSCREENER_CORE_DISCOVERY["dexscreener.tokenPairs"],
  },
];
