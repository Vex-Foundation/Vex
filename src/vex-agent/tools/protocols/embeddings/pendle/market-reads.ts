/**
 * Retrieval metadata for the Pendle MARKET-DATA reads — one market's detail,
 * its history and candles, its order-book depth, wallet merkle rewards, and
 * asset price marks.
 *
 * Manifests at `pendle/manifests/{market-get,market-history,market-candles,
 * orderbook,rewards-merkle,prices-assets}.ts` reference entries by `toolId`.
 *
 * Boundary facts are placed where an agent would actually hit them, rather than
 * repeated in every passage: what a matured market cannot answer and what a
 * Pendle trade cannot express live in `market.get`; the automated-market-maker
 * limit lives in `orderbook`; "readable but not claimable" and the retired
 * vePENDLE surface live in `rewards.merkle`; "a mark is not a quote" lives in
 * both price-shaped passages.
 *
 * Retrieval vocabulary rides here and in the PARAM DESCRIPTIONS —
 * `paramKeywords` is derived from param keys at metadata compile and is never
 * hand-authored.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { PENDLE_CHAINS } from "../../pendle/discovery-text.js";

export const PENDLE_MARKET_READ_DISCOVERY = {
  "pendle.market.get": {
    embeddingText: embeddingText(
      `Look up one Pendle market by its market, principal-token or yield-token address, across all eleven chains — ethereum, optimism, bsc, monad, sonic, hyperevm, arbitrum, plasma, mantle, base and berachain — some of which may list no active markets. ` +
      `Use when the user asks what a market is, when it expires, which tokens it accepts, or its rate now. ` +
      `Returns every leg, days to maturity, accepted tokens, and implied APY. A matured market has no live rates. ` +
      `A direct principal-to-yield-token swap is not offered, and a trade names what goes in, never a guaranteed amount out. ` +
      `Example queries: what is this pendle market, when does this PT expire.`,
    ),
    aliases: ["pendle market details", "pendle market info", "what tokens does this market accept", "pendle implied apy now"],
    exampleIntents: ["what is this pendle market", "when does this PT expire", "which tokens can I use on this market"],
    chains: PENDLE_CHAINS,
  },

  "pendle.market.history": {
    embeddingText: embeddingText(
      `See how a Pendle market's fixed rate, underlying rate, pool size and token prices have moved over hours, days or weeks. ` +
      `Use when the user wants to know whether today's implied APY is high or low before locking a rate until expiry, or how deep the market has been. ` +
      `Returns one row per point plus the minimum, maximum, first, last and relative change for every series requested, so a trend is answered without reading the rows. ` +
      `Past rates describe history and do not predict the rate a trade will get. ` +
      `Example queries: pendle implied apy history, has this fixed rate gone up, pendle market tvl over time.`,
    ),
    aliases: ["pendle rate history", "implied apy over time", "pendle market chart", "pendle tvl history"],
    exampleIntents: ["pendle implied apy history", "has this pendle rate gone up", "pendle market tvl over time"],
    chains: PENDLE_CHAINS,
  },

  "pendle.market.candles": {
    embeddingText: embeddingText(
      `Price candles for one Pendle principal token, yield token or liquidity token — open, high, low, close and volume, by hour, day or week. ` +
      `Use when the user asks how a PT or YT price has moved before buying or exiting one, or wants the recent price range of a Pendle asset. ` +
      `A candle with no trades reports no volume rather than a measured zero, and liquidity-token volume always reads zero here, so the market history series carries the real traded figure. ` +
      `These are provider price marks, not executable quotes. ` +
      `Example queries: pendle PT price chart, how has this YT moved this week, pendle candles.`,
    ),
    aliases: ["pendle price chart", "PT candles", "YT price history", "pendle ohlc"],
    exampleIntents: ["pendle PT price chart", "how has this YT moved", "pendle candles this week"],
    chains: PENDLE_CHAINS,
  },

  "pendle.orderbook": {
    embeddingText: embeddingText(
      `See the resting orders on a Pendle market — implied yield levels and their sizes on both the long-yield and short-yield sides, with the best level on each side. ` +
      `Use when the user asks how deep a Pendle market is, or whether a better price exists than the one quoted. ` +
      `Vex trades Pendle through its automated market maker only, so these resting orders show the price quality being forgone and Vex cannot fill them. ` +
      `A market Pendle has not opened to resting orders says so plainly rather than reporting an empty book. ` +
      `Example queries: pendle order book depth, is there a better pendle price, resting pendle orders.`,
    ),
    aliases: ["pendle order book", "pendle depth", "limit orders on pendle", "pendle resting orders"],
    exampleIntents: ["pendle order book depth", "how deep is this pendle market", "better pendle price than the quote"],
    chains: PENDLE_CHAINS,
  },

  "pendle.rewards.merkle": {
    embeddingText: embeddingText(
      `List the campaign and incentive rewards Pendle has accrued to the session wallet and distributes away from the market — per reward token, with the amount, the accrual window, and a dollar value where the token can be priced. ` +
      `Use when the user asks about pending Pendle rewards, incentive campaigns, or unclaimed payouts. ` +
      `Vex cannot claim these: Pendle publishes the amount but not the proof a claim needs, so they are claimed on Pendle's own site. Accrued interest and rewards Vex can sweep live in the Pendle claim tool, and the retired vePENDLE surface is not covered. ` +
      `Example queries: pending pendle rewards, unclaimed pendle incentives, pendle campaign payouts.`,
    ),
    aliases: ["pendle rewards", "unclaimed pendle incentives", "pendle campaign rewards", "pendle airdrop rewards"],
    exampleIntents: ["pending pendle rewards", "unclaimed pendle incentives", "what pendle rewards do I have"],
    chains: PENDLE_CHAINS,
  },

  "pendle.prices.assets": {
    embeddingText: embeddingText(
      `Dollar price marks for Pendle principal tokens, yield tokens, liquidity tokens and standardised yield tokens on one chain, including assets the wallet does not hold. ` +
      `Use when the user wants to price a Pendle asset by address, or to value a holding outside the portfolio. ` +
      `Prices refresh roughly every fifteen to sixty seconds and are display figures rather than executable quotes — a market read gives the rate a trade is priced against. ` +
      `An asset Pendle does not price is named rather than dropped, so an unpriced asset never reads as a worthless one. ` +
      `Example queries: what is this PT worth, price a pendle LP token, pendle asset price.`,
    ),
    aliases: ["pendle asset price", "PT price in dollars", "price a pendle token", "pendle usd marks"],
    exampleIntents: ["what is this PT worth", "price a pendle LP token", "pendle asset price in usd"],
    chains: PENDLE_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 6;
if (Object.keys(PENDLE_MARKET_READ_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `PENDLE_MARKET_READ_DISCOVERY has ${Object.keys(PENDLE_MARKET_READ_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
