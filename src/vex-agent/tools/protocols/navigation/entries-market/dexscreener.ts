/**
 * Navigation for the DexScreener namespace, after the S3.5 retirement and the
 * S4 deep-dive family.
 *
 * Every claim below describes the 18 tools that now exist on DexScreener's own
 * website channels. Two rewrites here are corrections rather than additions:
 *
 *  - The 12 public-API tools were retired whole (owner decision D-DS2,
 *    alias-free), and with them the facts this entry used to state: there is no
 *    CTO feed, no per-token promotional-orders tool, no synthetic
 *    profile-plus-boost merge, and screening no longer happens locally over 30
 *    provider-chosen rows.
 *  - "It does not establish contract safety" stood here through S3.5 and is no
 *    longer true: `pair.details` reads third-party audits, holder distribution
 *    and LP locks. It is replaced rather than deleted, because the honest
 *    statement is narrower than either extreme - the namespace RELAYS audit
 *    evidence, does not perform one, and reports a missing block as unavailable
 *    rather than clean.
 *
 * Leaving either sentence would route the model at something untrue.
 */

import type { ProtocolNamespaceNavigation } from "../types.js";

export const DEXSCREENER_NAVIGATION: ProtocolNamespaceNavigation = {
  namespace: "dexscreener",
  advertised: true,
  groupId: "market-research",
  groupLabel: "Market Research",
  summary:
    "Vex's read-only market-research backbone and source of truth for DexScreener-indexed AMM "
    + "pairs, including robinhood, plus DexScreener's own narrative and promotion labels. "
    + "Research flow: screen or search -> resolve the exact chain and contract address -> verify "
    + "pool depth -> quote on a venue. "
    + "Characteristic: its pool depth, liquidity and volume observations are real, but indexing "
    + "LAGS - on some chains a new pair takes hours to appear - so it answers how deep and how "
    + "real a market is, not what launched in the last minute, and it is not a token-creation "
    + "feed. "
    + "Deep dive: one pool's safety report, its candles from 1 second to 1 month, its trades "
    + "with a per-trade wallet profile, and its trader leaderboard. "
    + "It does not establish token identity from a ticker, complete market coverage, or an "
    + "executable price. Its safety report relays third-party audits and holder data and is "
    + "evidence, not a verdict: a missing audit block reads unavailable and never clean.",
  whenToUse:
    "Route exactly: which pairs are moving -> the screening boards (`pairs.trending`, "
    + "`pairs.top`, `gainers`, `losers`, `pairs.new`, `launchpad.pairs`, `tokens.screen`); "
    + "name or symbol -> `search`, then verify the address; token address + chain -> "
    + "`tokenPairs`; pool address + chain -> `pair.get`; addresses you already have -> "
    + "`pairs.batch`; which theme is moving -> `trending` (narratives), then pass a row's `id` "
    + "as `metaIds` to a screening board; who is paying for visibility -> `spotlight`; which "
    + "chains and dexes exist -> `chains`; is this token safe, who holds it, is liquidity "
    + "locked -> `pair.details`; price history, chart, volatility -> `candles`; who is buying "
    + "or selling, one wallet's activity on a pool -> `trades`; who bought or sold the most on "
    + "a pool -> `top.traders`. "
    + "Narratives and boost feeds are provider labels influenced by engagement and payment, "
    + "not organic or genuine rankings, and a boost is bought visibility rather than demand.",
  preferInstead:
    "`pair.details` relays GoPlus and QuickIntel audits rather than performing one, so treat it as "
    + "third-party evidence and prefer a dedicated chain safety tool when a verdict is needed. For "
    + "execution, always request a fresh quote from `kyberswap`, `solana`, or the chosen venue; "
    + "never treat a DexScreener price or candle close as executable.",
  declaration: {
    identity:
      "DexScreener is read-only market research for indexed automated-market-maker pairs and the provider's own narrative and promotion labels.",
    read:
      "Resolve a name or ticker symbol to an exact chain and contract address, screen the population server-side, list one token's pools, read a pool address live, refresh known addresses, aggregate narratives per chain, read paid boosts, and list the chain and dex catalog. Rows carry liquidity, volume, price change, counts, age and market cap. For one pool it also reads a safety report of third-party audits, taxes, holder concentration and LP lock percentage, OHLCV candles and price history from 1 second to 1 month, trade history with a counterparty wallet profile on every row, and a bounded top traders leaderboard.",
    quote:
      "No quote capability is available. Observations are display data, not a fresh executable quote.",
    act: "No action capability is available. This namespace never signs, broadcasts, buys, sells, or changes provider data.",
    whenItApplies:
      "Use it for screening, new pairs, gainers, losers, pair liquidity research, narrative questions, a token safety and holder check, price history and charts, or who is trading a pool.",
    characteristicAndLimits:
      "Indexing lags, and a missing row does not prove that no market exists. Screen counts drift; search and token-pool reads cap at 30 rows, no continuation; the trader leaderboard is one bounded set with no continuation at all. Rankings and narrative membership are an opaque classification shaped by engagement and payment. Audit blocks come from third parties and a missing one reads unavailable, never clean. Trader figures are venue-local cash flow and holdings, never profit, and cannot see transfers or other venues. It does not establish canonical identity from a ticker, market coverage, demand, or an executable price.",
    // Every term here must appear BOTH in the declaration prose above and in
    // the namespace's frozen tool passages (protocol-declarations.test.ts).
    // The passages are coordinator-authored under D-DS7 and may not be
    // reworded, so the vocabulary is taken FROM them rather than invented.
    retrievalTerms: [
      "ticker symbol",
      "contract address",
      "liquidity",
      "market cap",
      "volume",
      "price change",
      "new pairs",
      "gainers",
      "losers",
      "narratives",
      "chain and dex catalog",
      "holder concentration",
      "LP lock percentage",
      "taxes",
      "price history",
      "trade history",
      "top traders",
    ],
    facets: [
      "Market screening and leaderboards",
      "Search and token pools",
      "Pair snapshot and batch refresh",
      "Narratives and market context",
      "Paid attention and promotion feeds",
      "Chain and DEX catalog",
      "Token safety and holders",
      "Price history and charts",
      "Trades and trader leaderboard",
    ],
    coverageNote:
      "Coverage follows the provider's index; name the chain. Narratives are aggregated for any chain that has narrative activity, and a chain with none answers quietly as none active rather than being refused.",
  },
  exampleQueries: [
    'ToolSearch(query="trending narratives", namespace="dexscreener")',
    'ToolSearch(query="biggest gainers today", namespace="dexscreener")',
    'ToolSearch(query="pair liquidity research", namespace="dexscreener")',
    'ToolSearch(query="is this token safe", namespace="dexscreener")',
    'ToolSearch(query="price history candles", namespace="dexscreener")',
  ],
  aliases: ["dex screener", "market research", "trending narratives", "screener"],
  discoveryHints: [
    "token search",
    "pair analytics",
    "market screening",
    "trending narratives",
    "gainers",
    "boosts",
    "new pairs",
    "token safety",
    "price history",
    "trade history",
    "top traders",
  ],
  facets: [
    {
      label: "Market screening and leaderboards",
      summary:
        "Server-side screening of the whole indexed population: trending, metric leaders, gainers, losers, brand-new pairs, launchpad bonding and graduated boards, and the deduplicated token-level view.",
      toolPrefixes: [
        "dexscreener.pairs.trending",
        "dexscreener.pairs.top",
        "dexscreener.gainers",
        "dexscreener.losers",
        "dexscreener.pairs.new",
        "dexscreener.launchpad.pairs",
        "dexscreener.tokens.screen",
      ],
      hints: [
        "trending pairs",
        "top volume",
        "gainers",
        "losers",
        "new pairs",
        "launchpad",
        "bonding curve",
        "token leaderboard",
        "screening",
      ],
    },
    {
      label: "Search and token pools",
      summary:
        "Resolve a name, symbol or address to an exact chain and contract, optionally scoped to one chain on the provider, then list every pool that token trades in within the provider's bounded window, deepest first.",
      toolPrefixes: ["dexscreener.search", "dexscreener.tokenPairs"],
      hints: [
        "token search",
        "find pair",
        "contract for this ticker",
        "all pools",
        "where does it trade",
        "deepest pool",
        "liquidity split",
      ],
    },
    {
      label: "Pair snapshot and batch refresh",
      summary:
        "Point reads on identities the agent already has: one pair's full live state in about a kilobyte, or many known pairs and tokens refreshed in a single frame with every input accounted for.",
      toolPrefixes: ["dexscreener.pair.get", "dexscreener.pairs.batch"],
      hints: [
        "pair snapshot",
        "current price of this pair",
        "poll this position",
        "watchlist refresh",
        "compare these pairs",
        "batch snapshot",
      ],
    },
    {
      label: "Narratives and market context",
      summary:
        "Which theme or sector is moving, aggregated per chain: market cap, change, volume, liquidity and token count per narrative, each row carrying the id the screening boards accept as `metaIds`.",
      toolPrefixes: ["dexscreener.trending"],
      hints: [
        "trending narratives",
        "which meta is pumping",
        "sector rotation",
        "AI tokens market cap",
        "cat coins versus dog coins",
      ],
    },
    {
      label: "Paid attention and promotion feeds",
      summary:
        "Who is paying for visibility right now: the most-boosted tokens, the boosts just purchased, and the newest issuer-published profiles, from the one endpoint the website itself uses.",
      toolPrefixes: ["dexscreener.spotlight"],
      hints: [
        "boosted tokens",
        "who just bought a boost",
        "newest token profiles",
        "what is being promoted",
      ],
    },
    {
      label: "Chain and DEX catalog",
      summary:
        "The vocabulary source: which chains and dexes are indexed, their explorer link templates, which audit integrations exist per chain, and which chains carry narratives.",
      toolPrefixes: ["dexscreener.chains"],
      hints: ["supported chains", "list dexes", "chain slugs", "explorer links"],
    },
    {
      label: "Token safety and holders",
      summary:
        "One pool's safety report: third-party audit blocks kept separate with their disagreements listed, taxes, honeypot and mint flags, holder concentration next to the rows it covers, LP locks, supply and chain authority. A missing block reads unavailable, never clean.",
      toolPrefixes: ["dexscreener.pair.details"],
      hints: [
        "token safety",
        "honeypot",
        "is this a scam",
        "who holds this token",
        "holder concentration",
        "LP lock percentage",
        "taxes",
        "can the owner mint",
      ],
    },
    {
      label: "Price history and charts",
      summary:
        "OHLCV candles for one pool at any of 18 resolutions from 1 second to 1 month, over any historical window, in USD or the native quote, as a price or market-cap series, with the covered range and whether the newest bar is still forming stated on every answer.",
      toolPrefixes: ["dexscreener.candles"],
      hints: [
        "price history",
        "candles",
        "OHLC",
        "chart",
        "volatility",
        "market cap history",
        "daily chart",
      ],
    },
    {
      label: "Trades and trader leaderboard",
      summary:
        "Who traded one pool: trade-by-trade history with a counterparty wallet profile on every row and filters on side, size, time and wallet, plus a bounded leaderboard of the wallets that bought or sold the most. Venue-local cash flow, never profit.",
      toolPrefixes: ["dexscreener.trades", "dexscreener.top.traders"],
      hints: [
        "trade history",
        "who is buying",
        "who is selling",
        "whale watching",
        "order flow",
        "wallet activity",
        "top traders",
        "wallet leaderboard",
      ],
    },
  ],
};
