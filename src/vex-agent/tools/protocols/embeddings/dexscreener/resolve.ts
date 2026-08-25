/**
 * Retrieval metadata for the DexScreener site RESOLVE family: the single-pair
 * snapshot, the paid-attention spotlight, the explicit-identity batch
 * snapshot, the pair text search, and one token's pool list.
 *
 * Every passage, summary, alias and example intent below is used VERBATIM from
 * `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` (owner decision
 * D-DS7: the coordinator authors all retrieval text personally and builders
 * consume it without rewording). Whitespace is re-wrapped to fit this file;
 * no word is changed. A correction belongs in that document first.
 *
 * The authoring rules those passages were written against, recorded here so a
 * later edit does not quietly break them: English only, 60 to 110 words, a
 * `Use this when` anchor, an `Example queries:` anchor, the distinguishing
 * noun front-loaded, chains named in prose, and no sentence shared with a
 * sibling passage. Polish user vocabulary lives in `aliases` and
 * `exampleIntents`, which feed the lexical fallback lane and are the only
 * surface where it is legal.
 *
 * IDENTITY CONTINUITY. `dexscreener.search` and `dexscreener.tokenPairs` are
 * RECLAIMED toolIds, not new ones: the public-API tools that held them were
 * retired whole in S3.5 and these tools answer the same user question through
 * the website channel instead. The toolId is deliberately unchanged so every
 * durable row, audit record and classifier map that already refers to it keeps
 * its meaning without a migration (identity-and-migration.md section 1). The
 * ANSWER changed and the question did not, which is exactly the case the
 * immutable-toolId rule exists for.
 *
 * `dexscreener.trending` is reclaimed the same way by the narratives tool,
 * whose passage lives in `./market-context.ts`.
 *
 * Manifests at `dexscreener/manifests/resolve.ts` reference entries by
 * `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_RESOLVE_DISCOVERY = {
  "dexscreener.pair.get": {
    canonicalSummary:
      "Full live snapshot of one pair in one call: price, flow, makers, and all four time windows.",
    embeddingText: embeddingText(
      `Live snapshot of a single pair: current price in USD and native units, price ` +
        `change, volume, buys and sells, distinct buyers, sellers, and makers for all ` +
        `four windows (5m, 1h, 6h, 24h), buy versus sell volume split, liquidity, market ` +
        `cap, FDV, pair age, boosts, and the token's profile links. About one kilobyte, ` +
        `suitable for polling a position. Use this when one specific pair is already ` +
        `identified and the question is its current state; for safety audits and holders ` +
        `call dexscreener__pair_details_get. Example queries: current price of this ` +
        `pair, live stats for this pool, how is this token doing right now, quick ` +
        `snapshot of this address, poll this position.`,
    ),
    aliases: [
      "pair snapshot",
      "live price",
      "cena teraz",
      "stan pary",
      "podglad pozycji",
    ],
    exampleIntents: [
      "jaka jest teraz cena tej pary",
      "pokaz stan tej puli",
      "how is this pair doing",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.spotlight": {
    canonicalSummary:
      "Paid-attention feeds in one call: top boosted tokens, fresh boosts, and the newest token profiles.",
    embeddingText: embeddingText(
      `Paid attention on DexScreener: the top boosted tokens, the most recent boost ` +
        `purchases, and the newest token profiles (up to 30, 30, and 36 rows), in a ` +
        `single call, each with token identity and chain. Distinguishes who has paid the most ` +
        `overall from who just started paying, which is the earliest promotion signal ` +
        `DexScreener emits. A boost is bought visibility, and rows say so plainly. Use ` +
        `this when the user asks who is advertising, boosting, or promoting right now; ` +
        `organic momentum lives in dexscreener__pairs_trending_list. Example queries: ` +
        `most boosted tokens right now, who just bought a boost, newest token profiles, ` +
        `what is being promoted today, fresh marketing pushes.`,
    ),
    aliases: [
      "boosts",
      "promoted tokens",
      "kto sie promuje",
      "boostowane tokeny",
      "platna promocja",
    ],
    exampleIntents: [
      "kto sie teraz promuje",
      "swieze boosty z ostatniej chwili",
      "most boosted tokens today",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.pairs.batch": {
    canonicalSummary:
      "Refresh a list of known pairs or tokens in one call: a batch snapshot for watchlists and portfolios.",
    embeddingText: embeddingText(
      `Batch snapshot of many pairs at once: pass known pair or token addresses ` +
        `across any mix of chains and get current rows back in one frame with price, ` +
        `volume, liquidity, market cap, and flow for all windows. Built for ` +
        `watchlists, portfolio refresh, and side-by-side comparison without one call ` +
        `per pair. Every input is accounted for: resolved, invalid, duplicate, or ` +
        `omitted by the provider, nothing disappears silently. Use this when a pair set is ` +
        `already known and the question is its current state; discovery lives in the ` +
        `screening and search tools. Example queries: refresh my ` +
        `watchlist, current stats for these pairs, compare these tokens, snapshot my ` +
        `portfolio, update my tracked pools.`,
    ),
    aliases: [
      "batch snapshot",
      "watchlist refresh",
      "moja lista",
      "odswiez portfel",
      "porownaj pary",
    ],
    exampleIntents: [
      "odswiez moja liste obserwowanych",
      "porownaj te trzy pary",
      "current stats for these addresses",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.search": {
    canonicalSummary:
      "Find pairs by token name, symbol, or address, optionally scoped to one chain server-side.",
    embeddingText: embeddingText(
      `Search pairs by token name, ticker symbol, or contract address, across all ` +
        `chains or scoped to one chain like Solana or Base, honoured server-side. An ` +
        `exact contract address returns that token's pools directly; text returns up to ` +
        `30 relevance-ranked matches with full metrics per row. Use this when the user ` +
        `names a token whose address is not yet known; once a result is chosen, ` +
        `continue with dexscreener__pair_get or dexscreener__token_pairs_list. A ticker ` +
        `is not identity: same-name copycats are normal, so verify by address, ` +
        `liquidity, and age. Example queries: find PEPE on solana, search token by ` +
        `name, contract for WIF, lookup this address, find bonk pairs.`,
    ),
    aliases: [
      "search token",
      "find pair",
      "znajdz token",
      "wyszukaj po nazwie",
      "szukaj kontraktu",
    ],
    exampleIntents: [
      "znajdz PEPE na solanie",
      "jaki jest kontrakt WIF",
      "search dog tokens on bsc",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.tokenPairs": {
    canonicalSummary:
      "The pools a token trades in, deepest of the returned window first, with each pool's share of the returned liquidity and volume.",
    embeddingText: embeddingText(
      `Pools and markets for one token address: the DEX pairs where it trades, ` +
        `deepest first within the provider's returned window, with each pool's share of ` +
        `the returned liquidity and volume, labels like CLMM or v3, and the quote ` +
        `asset. Answers where a token trades, which returned pool is deepest, and ` +
        `whether liquidity looks concentrated or fragmented, the routing input before ` +
        `any swap. Use this when identity is known by address; to find the address ` +
        `first use dexscreener__pairs_search. Example queries: pools for this token, ` +
        `where does WIF trade, deepest returned pool for this address, liquidity split ` +
        `across dexes, which pair should I chart.`,
    ),
    aliases: [
      "token pools",
      "all markets",
      "pule tokena",
      "gdzie handlowac",
      "najglebsza pula",
    ],
    exampleIntents: [
      "pokaz wszystkie pule tego tokena",
      "gdzie jest najwieksza plynnosc dla WIF",
      "which pool is deepest",
    ],
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

/**
 * Guard the count, matching the sibling embedding modules: a passage silently
 * dropped in a merge would degrade retrieval without failing any type check.
 */
const EXPECTED_COUNT = 5;
if (Object.keys(DEXSCREENER_RESOLVE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_RESOLVE_DISCOVERY has ${Object.keys(DEXSCREENER_RESOLVE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
