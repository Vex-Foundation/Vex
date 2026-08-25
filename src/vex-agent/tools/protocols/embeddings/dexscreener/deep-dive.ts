/**
 * Retrieval metadata for the DexScreener DEEP-DIVE family: pair details,
 * candles, trades and top traders.
 *
 * The passages, summaries, aliases and example intents below are used VERBATIM
 * from `tool-surface-spec/dexscreener-site/tool-descriptions-v1.md` sections 10
 * to 13 (owner decision D-DS7: the coordinator authors all retrieval text
 * personally and builders consume it without rewording). Whitespace is
 * re-wrapped to fit this file; no word is changed. A correction belongs in that
 * document first.
 *
 * WHY ITS OWN MODULE. These four tools are the only ones on this surface whose
 * subject is ONE pool rather than a population. They read four different
 * channels with four different codecs, they are the only tools that carry
 * wallet-level vocabulary, and they will change for different reasons than the
 * boards do. `./resolve.ts` answers "which pool"; this module answers "what is
 * true about that pool".
 *
 * The manifest at `dexscreener/manifests/deep-dive.ts` references these
 * entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { DEXSCREENER_CHAINS } from "../../dexscreener/discovery-text.js";

export const DEXSCREENER_DEEP_DIVE_DISCOVERY = {
  "dexscreener.pair.details": {
    canonicalSummary:
      "Safety and ownership report for a pair: audits, taxes, honeypot flags, holders, LP locks, supply, and listings.",
    embeddingText: embeddingText(
      `Token safety report: GoPlus and QuickIntel audits with honeypot flags, ` +
        `taxes, mint and blacklist capability, contract verification, owner balances, ` +
        `holder concentration, LP lock percentage, supply, Solana mint and freeze ` +
        `authority, and CoinGecko or CoinMarketCap listings. Coverage comes from the ` +
        `response and is reported per source: native and GoPlus holder lists stay ` +
        `distinct, percentages keep provider units beside normalized values, and a ` +
        `missing block reads unavailable, never clean. Use this when the user asks ` +
        `if a token is safe, a honeypot, a rug risk, or who holds it. Example queries: ` +
        `is this token safe, honeypot check, who holds this token, is liquidity ` +
        `locked, what are the taxes, can the owner mint.`,
    ),
    aliases: [
      "safety check",
      "honeypot",
      "audyt tokena",
      "kto trzyma token",
      "czy scam",
      "liquidity lock",
    ],
    exampleIntents: [
      "czy ten token to scam",
      "sprawdz honeypot i podatki",
      "kto ma najwiecej tego tokena",
      "czy plynnosc jest zablokowana",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.candles": {
    canonicalSummary:
      "OHLCV candles from 1 second to 1 month for any pair, any time period, in USD or native, as price or market cap.",
    embeddingText: embeddingText(
      `OHLCV candles and price history for any pair on any chain: resolutions ` +
        `from 1 second through 1m, 5m, 1h, 4h to daily, weekly, monthly, in USD or ` +
        `native quote, as price or market-cap series, up to 999 bars per call with ` +
        `continuous paging back to the pair's first block. A start and end time ` +
        `select any historical window: the nearest prior trade anchors it, with ` +
        `anchor distance and coverage reported. Use this when the user wants a chart, ` +
        `price history, volatility, or OHLC data. Example queries: 1 hour candles for ` +
        `this pair, price chart last week, OHLC data since launch, 5 minute candles ` +
        `yesterday, market cap history, daily chart.`,
    ),
    aliases: [
      "candles",
      "OHLC",
      "price chart",
      "swieczki",
      "wykres ceny",
      "historia cen",
    ],
    exampleIntents: [
      "pokaz swieczki 1h z ostatnich 3 dni",
      "wykres dzienny od startu",
      "5 minute candles for yesterday",
      "godzinowe OHLC z marca",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.trades": {
    canonicalSummary:
      "Trade-by-trade history for a pair with a counterparty profile on every row, filters on side, size, time, and wallet.",
    embeddingText: embeddingText(
      `Trade history for a pair: each buy and sell with price, USD size, ` +
        `timestamp, transaction hash, and the counterparty wallet's profile on the ` +
        `row: lifetime buys and sells here, dollars in and out, retained share of ` +
        `purchases, newcomer flag. Filters by side, USD size range, time window to ` +
        `the second, or one wallet address, plus liquidity add and remove events; an ` +
        `aggregate mode summarises net flow, unique buyers versus sellers, and the ` +
        `size histogram. Use this when the user asks who is buying or selling, whale ` +
        `watching, or wallet activity. Example queries: who is buying this token, ` +
        `recent large sells, trades of this wallet, whale buys last hour, order flow.`,
    ),
    aliases: [
      "trades",
      "trade history",
      "order flow",
      "whale trades",
      "buys and sells",
      "kto kupuje",
      "historia transakcji",
      "ruchy wielorybow",
    ],
    exampleIntents: [
      "who is buying this token right now",
      "show me whale trades on this pair",
      "largest sells in the last hour",
      "kto kupuje ten token",
      "duze sprzedaze z ostatniej godziny",
      "pokaz transakcje tego portfela",
    ],
    chains: DEXSCREENER_CHAINS,
  },

  "dexscreener.top.traders": {
    canonicalSummary:
      "Ranked wallet leaderboard for a pair: who bought and sold the most, cash taken out, and current holding value.",
    embeddingText: embeddingText(
      `Top traders leaderboard for a pair: a bounded pair-local ranking of up to ` +
        `100 wallets by bought USD, sold USD, net venue cash flow, or current holding ` +
        `value, with buys, sells, dollars in and out, retained purchase share, and ` +
        `first and last trade times, inside the provider's 30-day window. It ` +
        `cannot establish profit, exit status, global accumulation, or smart-money ` +
        `quality: cost basis, transfers, and other venues are invisible here. Use ` +
        `this when the user asks who bought or sold the most on a pair; for ` +
        `chronological or wallet-filtered flow use dexscreener__trades_list. Example ` +
        `queries: top traders of this token, biggest buyers of this pair, who sold ` +
        `the most, wallet leaderboard.`,
    ),
    aliases: [
      "top traders",
      "top wallets",
      "biggest buyers",
      "wallet leaderboard",
      "whale wallets",
      "najlepsi traderzy",
      "kto zarobil",
      "ranking portfeli",
    ],
    exampleIntents: [
      "which wallets bought the most of this token",
      "top traders on this pair",
      "kto najwiecej zarobil na tym tokenie",
      "czy pierwsi kupujacy dalej trzymaja",
      "top 10 portfeli tej pary",
    ],
    chains: DEXSCREENER_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

/**
 * Guard the count, matching the sibling embedding modules: a passage silently
 * dropped in a merge would degrade retrieval without failing any type check.
 */
const EXPECTED_COUNT = 4;
if (Object.keys(DEXSCREENER_DEEP_DIVE_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `DEXSCREENER_DEEP_DIVE_DISCOVERY has ${Object.keys(DEXSCREENER_DEEP_DIVE_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
