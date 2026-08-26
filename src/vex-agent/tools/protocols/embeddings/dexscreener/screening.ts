/**
 * Retrieval metadata for the DexScreener site screening family and the chain
 * catalog (8 tools).
 *
 * Every passage, summary, alias and example intent below is used VERBATIM from
 * `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` (owner decision
 * D-DS7: the coordinator authors all retrieval text personally and builders
 * consume it without rewording). Whitespace is re-wrapped to fit this file;
 * no word is changed. A correction belongs in that document first.
 *
 * The authoring rules those passages were written against, recorded here so a
 * later edit does not quietly break them: English only, 60 to 110 words, a
 * `Use this when` anchor, an `Example queries:` anchor, the distinguishing noun
 * front-loaded, chains named in prose, and no sentence shared with a sibling
 * passage. Polish user vocabulary lives in `aliases` and `exampleIntents`,
 * which feed the lexical fallback lane and are the only surface where it is
 * legal.
 *
 * Manifests at `dexscreener/manifests/screening.ts` reference entries by
 * `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_SCREENING_DISCOVERY = {
  "dexscreener.pairs.trending": {
    canonicalSummary:
      "Rank the hottest trading pairs on a chain by DexScreener's trending score for a 5m, 1h, 6h, or 24h window.",
    embeddingText: embeddingText(
      `Trending pairs and hot tokens ranked by DexScreener's trending score for a ` +
        `selected window: 5 minutes, 1 hour, 6 hours, or 24 hours, on Solana, Base, ` +
        `Ethereum, BSC, or any of 74 chains. Returns the same ordering as the ` +
        `DexScreener homepage, each row with price change, volume, liquidity, market ` +
        `cap, buyers versus sellers, and its share of the whole chain's volume. Use this ` +
        `when the user asks what is hot, moving, or gaining attention right now; for ` +
        `strict metric leaders call dexscreener__pairs_top_list instead. Example ` +
        `queries: what is trending on solana, hottest memecoins right now, top trending ` +
        `pairs last hour, what is moving on base today, show me hyped tokens.`,
    ),
    aliases: [
      "trending pairs",
      "hot tokens",
      "co pompuje",
      "na topie teraz",
      "gorace tokeny",
    ],
    exampleIntents: [
      "co jest teraz na topie na solanie",
      "pokaz trendy ostatniej godziny",
      "hottest pairs on base right now",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.pairs.top": {
    canonicalSummary:
      "Rank pairs on a chain by a hard metric: volume, transactions, buys, sells, liquidity, or market cap, for a chosen window.",
    embeddingText: embeddingText(
      `Top pairs by a hard metric: highest volume, most transactions, most buys or ` +
        `sells, deepest liquidity, or largest market cap, per 5-minute, 1-hour, 6-hour, ` +
        `or 24-hour window, on Solana, Ethereum, Base, BSC, and 70 more chains. Answers ` +
        `league-table questions with exact numbers per row and the chain's own totals ` +
        `for scale. Use this when the user wants leaders by a measurable metric; for ` +
        `attention-based ranking use dexscreener__pairs_trending_list. Example queries: ` +
        `top volume pairs on solana today, most traded tokens last hour, biggest ` +
        `liquidity pools on base, highest market cap memecoins, most active pairs by ` +
        `transactions.`,
    ),
    aliases: [
      "top volume",
      "most traded",
      "najwiekszy wolumen",
      "najczesciej handlowane",
      "lista topowych par",
    ],
    exampleIntents: [
      "najwiekszy wolumen 24h na solanie",
      "most traded pairs on bsc right now",
      "pokaz najplynniejsze pule",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.gainers": {
    canonicalSummary:
      "Biggest price gainers on a chain for a window, with a real quality floor against manipulated illiquid pairs.",
    embeddingText: embeddingText(
      `Biggest gainers: pairs with the largest price increase over 5 minutes, 1 hour, ` +
        `6 hours, or 24 hours on any chain DexScreener indexes. Applies the site's own ` +
        `quality floor by default (minimum transactions, sellers, volume, and liquidity) ` +
        `because an unfloored price-change sort returns broken billion-percent rows; ` +
        `every floor value is echoed and each can be loosened or removed by the agent. ` +
        `Use this when the user asks what pumped, mooned, or gained the most; for ` +
        `declines call dexscreener__losers_list. Example queries: biggest gainers today ` +
        `on solana, what pumped last hour, top price increases 24h, best performing ` +
        `memecoins this week, largest green candles on base.`,
    ),
    aliases: [
      "gainers",
      "biggest pumps",
      "najwieksze wzrosty",
      "co urosło dzisiaj",
      "zyski 24h",
    ],
    exampleIntents: [
      "co najbardziej urosło dzisiaj",
      "najwieksze pumpy ostatniej godziny na solanie",
      "top gainers on base",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.losers": {
    canonicalSummary:
      "Biggest price losers on a chain for a window, same quality floor as gainers, ascending order.",
    embeddingText: embeddingText(
      `Biggest losers: pairs with the deepest price drop over 5 minutes, 1 hour, 6 ` +
        `hours, or 24 hours on any indexed chain, quality-floored the same way the ` +
        `DexScreener losers page is so dead pairs do not drown the answer. Shows how ` +
        `hard each token is dumping, who is selling into it, and whether liquidity is ` +
        `leaving. Use this when the user asks what is crashing, dumping, or bleeding; ` +
        `rising pairs live in dexscreener__gainers_list. Example queries: biggest losers ` +
        `today, what is dumping on solana right now, worst performing tokens 24h, ` +
        `largest price drops this hour, what crashed on base.`,
    ),
    aliases: [
      "losers",
      "biggest dumps",
      "najwieksze spadki",
      "co spada",
      "czerwone tokeny",
    ],
    exampleIntents: [
      "co najbardziej spada dzisiaj",
      "najwieksze dumpy na solanie",
      "worst performers last 24h",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.pairs.new": {
    canonicalSummary:
      "Newly created pairs on a chain, newest first, with age and liquidity floors the agent controls.",
    embeddingText: embeddingText(
      `New pairs and fresh token listings, newest first, with exact age in seconds, ` +
        `starting liquidity, first-hours volume, and buyer flow, on Solana, Base, BSC, ` +
        `Ethereum, and every other indexed chain. Defaults to pairs younger than 24 ` +
        `hours with a small liquidity floor; the agent can widen to any age or drop the ` +
        `floor entirely. Use this when the user asks what just launched or wants brand ` +
        `new tokens to inspect; for bonding-curve launchpad listings call ` +
        `dexscreener__launchpad_pairs_list. Example queries: new pairs on solana last ` +
        `hour, tokens launched today, fresh listings with liquidity above 50k, newest ` +
        `memecoins right now, what launched on base.`,
    ),
    aliases: [
      "new pairs",
      "fresh listings",
      "nowe pary",
      "nowe tokeny",
      "swieze listingi",
    ],
    exampleIntents: [
      "nowe pary z ostatniej godziny",
      "co dzisiaj wystartowalo na solanie",
      "new tokens with 20k liquidity",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.launchpad.pairs": {
    canonicalSummary:
      "Launchpad boards: tokens still on a bonding curve or already graduated, per launchpad and chain, with progress percent.",
    embeddingText: embeddingText(
      `Launchpad tokens on bonding curves: pump.fun, LaunchLab, Meteora DBC, Bags on ` +
        `Solana, Four.meme on BSC, with bonding progress percent, creator wallet, market ` +
        `cap, and buyer flow, plus graduated boards for tokens that completed the curve ` +
        `and migrated to a DEX. Handles DexScreener's hidden default that normally ` +
        `excludes bonding-curve pairs from every list. Use this when the user asks about ` +
        `pump.fun launches, graduation progress, or pre-graduation snipes; ordinary new ` +
        `DEX pairs live in dexscreener__pairs_new_list. Example queries: pump fun tokens ` +
        `near graduation, bonding curve above 80 percent, new launchlab launches, ` +
        `graduated pumpfun tokens today, four meme board.`,
    ),
    aliases: [
      "launchpad",
      "pump.fun",
      "bonding curve",
      "pumpfun graduation",
      "tokeny z launchpada",
    ],
    exampleIntents: [
      "co jest blisko graduacji na pump.fun",
      "pokaz bonding curve powyzej 90 procent",
      "swieze graduaty pumpfun",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.chains": {
    canonicalSummary:
      "The 74 supported chains with their dexes, explorer link templates, audit integrations, and feature availability.",
    embeddingText: embeddingText(
      `Chain and DEX catalog: all 74 chains DexScreener indexes, each with its ` +
        `slug, display name, native chain ID, architecture, DEX list, block explorer ` +
        `URL templates, which audit providers cover it, and whether narratives are ` +
        `enabled there. The vocabulary source for every other DexScreener tool: valid ` +
        `chain slugs and dex slugs come from here, and unknown values ` +
        `elsewhere are refused with candidates from this catalog. Use this when the ` +
        `user asks which chains or dexes are supported, or when a chain slug needs ` +
        `verifying. Example queries: which chains are supported, list dexes on solana, ` +
        `is berachain indexed, explorer link for this chain, what chains have audits.`,
    ),
    aliases: [
      "chains",
      "supported networks",
      "lista sieci",
      "jakie dexy",
      "obslugiwane lancuchy",
    ],
    exampleIntents: [
      "jakie sieci obslugujesz",
      "pokaz dexy na solanie",
      "is monad supported",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.tokens.screen": {
    canonicalSummary:
      "Token leaderboard per chain: one aggregate row per token summing its pools, ranked by the provider's opaque score.",
    embeddingText: embeddingText(
      `Token leaderboard aggregating each token's pools on a chain: volume, ` +
        `liquidity, and transaction counts are sums across the token's pools, attached ` +
        `to one representative pool whose price and market cap can mislead by orders of ` +
        `magnitude and are labelled so. Coverage is the provider's profile-carrying ` +
        `universe, tokens can repeat across pages, and the ordering is the provider's ` +
        `opaque score, all reported rather than hidden. Use this when the user wants ` +
        `token-level aggregates on a chain; exact metric league tables and pool detail ` +
        `live in dexscreener__pairs_top_list. Example queries: top tokens on solana, ` +
        `token level volume across pools, token list for bsc, best tokens today, show ` +
        `me coins not pools.`
    ),
    aliases: [
      "token list",
      "top coins",
      "lista tokenow",
      "najwieksze tokeny",
      "ranking monet",
    ],
    exampleIntents: [
      "pokaz najwieksze tokeny na solanie",
      "lista coinow na base",
      "top tokens by market cap",
    ],
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

/**
 * Guard the count, matching the sibling embedding modules: a passage silently
 * dropped in a merge would degrade retrieval without failing any type check.
 */
const EXPECTED_COUNT = 8;
if (Object.keys(DEXSCREENER_SCREENING_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_SCREENING_DISCOVERY has ${Object.keys(DEXSCREENER_SCREENING_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
