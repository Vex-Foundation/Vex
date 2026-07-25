/**
 * Retrieval metadata for Solana / Jupiter predict tools.
 *
 * Source-of-truth for both the lexical scorer (`discovery.ts`) and the
 * future dense-retrieval pipeline (EmbeddingGemma 300M → pgvector). Manifest
 * at `solana-jupiter/manifests/predict.ts` references entries by `toolId`.
 */

import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";
import { SOLANA_CHAINS } from "../../solana-jupiter/discovery-text.js";

export const SOLANA_PREDICT_DISCOVERY = {
  "solana.predict.events": {
    canonicalSummary:
      "Browse events on a Jupiter prediction market on Solana — sports, crypto, politics, esports, culture, economics, tech.",
    embeddingText: embeddingText(
      `Browse events on Jupiter — a prediction market on Solana — across sports, crypto, politics, esports, culture, economics, tech — with binary YES/NO markets. ` +
      `Use this when the user wants to browse what they can bet on, see live or trending prediction markets, browse by category, or discover prediction opportunities. ` +
      `Example queries: browse prediction markets, what can I bet on, live sports markets, trending crypto predictions, politics prediction events, prediction events on solana.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "browse events", "trending markets",
      "live markets", "prediction events",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "browse jupiter prediction markets",
      "trending prediction events on solana",
      "what can I bet on solana",
      "live prediction markets",
    ],
    preferredFor: ["browse prediction events", "trending jupiter markets", "discover bets"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.search": {
    canonicalSummary:
      "Search a Jupiter prediction market on Solana by keyword across sports, crypto, politics, esports, culture, economics, and tech.",
    embeddingText: embeddingText(
      `Search Jupiter prediction market events on Solana by keyword across sports, crypto, politics, esports, culture, economics, and tech. ` +
      `Use this when the user wants to find a specific prediction market, search by topic (bitcoin, election, super bowl), filter the prediction catalog by keyword, or look up a specific event. ` +
      `Example queries: find bitcoin prediction markets, search election predictions, look up super bowl bets, find solana price markets, search prediction by keyword, find this prediction event.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "search predictions", "find market",
      "find event", "lookup prediction",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "search bitcoin prediction on solana",
      "find election prediction markets",
      "look up super bowl bets on jupiter",
      "search jupiter predict by keyword",
    ],
    preferredFor: ["search jupiter predict", "find prediction event", "lookup bet"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.market": {
    embeddingText: embeddingText(
      `Get full details of a single Jupiter prediction market on Solana — YES/NO prices, probability, volume, status, payout, metadata. ` +
      `Use this when the user wants the deep stats on one specific market, check the current odds before betting, see how a market is priced, or review trading conditions. ` +
      `Example queries: details for this prediction market, what's the current odds on this, yes no prices for this market, market depth before betting, status of this prediction.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "market details", "market by id",
      "yes no price", "odds check",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "details for this jupiter prediction market",
      "yes no price for this market",
      "current odds on this prediction",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.positions": {
    canonicalSummary:
      "List a wallet's open YES/NO positions on a Jupiter prediction-market outcome on Solana — exposure, unrealized PnL.",
    embeddingText: embeddingText(
      `Get a wallet's open Jupiter prediction positions on Solana — YES/NO sides, exposure, unrealized PnL, payout. ` +
      `Use this when the user wants to see their open prediction bets, check pending exposure, review unrealized PnL on bets, or list active prediction positions. ` +
      `Example queries: my open prediction bets, show my prediction positions, unrealized pnl on prediction, what bets do I have, active yes no positions.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "open positions", "open bets",
      "unrealized pnl", "active bets",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "my open solana prediction bets",
      "show my jupiter prediction positions",
      "unrealized pnl on jupiter predict",
      "active yes no bets on solana",
    ],
    preferredFor: ["my prediction positions", "open jupiter bets", "active prediction exposure"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.history": {
    canonicalSummary:
      "Get a wallet's settled trade history on a Jupiter prediction-market outcome on Solana — past buys, sells, claims, realized PnL.",
    embeddingText: embeddingText(
      `Get a wallet's full Jupiter prediction trade history on Solana — past buys, sells, claims, realized PnL, closed positions, settlement events. ` +
      `Use this when the user wants to review past prediction trades, see realized PnL on closed bets, audit their prediction activity, look at past prediction settlements, or browse closed positions paginated. ` +
      `Example queries: my prediction history, past prediction trades, realized pnl on prediction, closed prediction bets, audit my prediction activity, prediction trade log.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "trade history", "closed positions",
      "realized pnl", "settlement log",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "my jupiter prediction history",
      "past prediction trades on solana",
      "realized pnl on jupiter predict",
      "closed prediction bets",
    ],
    preferredFor: ["my prediction history", "closed jupiter bets", "realized prediction pnl"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.buy": {
    canonicalSummary:
      "Place a YES/NO buy order on a Jupiter prediction-market outcome on Solana, settled in USDC SPL.",
    embeddingText: embeddingText(
      `Buy YES or NO shares in a Jupiter prediction market on Solana to bet on the outcome of a real-world event — sports, crypto prices, politics, culture, tech. ` +
      `Use this when the user wants to bet on something, take a position on an outcome, buy yes or no shares, speculate on an event, or open a prediction trade. ` +
      `Example queries: bet on solana hitting 500, buy yes on this market, take the no side, speculate on the election, trade prediction outcome, place a bet.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "buy yes", "buy no", "buy shares", "buy outcome shares",
      "place bet", "yes share", "no share", "outcome shares",
      "USDC", "usdc spl", "open position",
    ],
    exampleIntents: [
      "bet yes on solana",
      "buy no shares on jupiter predict",
      "place a prediction trade on solana",
      "ape into this jupiter prediction market",
    ],
    preferredFor: ["place bet", "buy yes shares", "buy no shares", "open prediction position"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.sell": {
    canonicalSummary:
      "Sell or close a single position on a Jupiter prediction-market outcome on Solana before settlement.",
    embeddingText: embeddingText(
      `Sell or close one Jupiter prediction position on Solana. ` +
      `Use this when the user wants to exit a prediction bet, close a yes or no position before settlement, take profit on a prediction, or reduce exposure on a market. ` +
      `Example queries: sell my prediction position, exit this bet, close my yes shares, take profit on prediction, get out of this market early.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "sell position", "close bet", "exit position",
      "take profit", "early exit",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "exit my prediction position on solana",
      "sell my jupiter prediction position",
      "close my yes shares before settlement",
      "take profit on this jupiter bet",
    ],
    preferredFor: ["close prediction position", "exit jupiter bet", "take profit on prediction"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.claim": {
    canonicalSummary:
      "Claim a payout from a resolved position on a Jupiter prediction-market outcome on Solana.",
    embeddingText: embeddingText(
      `Claim winnings from a resolved Jupiter prediction position on Solana. ` +
      `Use this when the user wants to redeem a winning bet, settle a resolved position, claim payout for correct yes or no shares, cash out a successful prediction, or collect earnings from a finished prediction market. ` +
      `Example queries: claim my winning bet, redeem this prediction payout, settle resolved position, collect my prediction winnings, claim payout, cash out winning shares.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "claim payout", "redeem winnings", "settle position",
      "collect winnings", "winning bet",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "claim winning prediction bet on solana",
      "redeem my jupiter prediction payout",
      "settle resolved prediction position",
      "collect winnings on jupiter predict",
    ],
    preferredFor: ["claim prediction payout", "redeem winning bet", "settle resolved position"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.closeAll": {
    canonicalSummary:
      "Batch-close every open position on a Jupiter prediction-market outcome on Solana for a wallet.",
    embeddingText: embeddingText(
      `Close every open Jupiter prediction position on Solana for a wallet in batch. ` +
      `Use this when the user wants to wipe out all open prediction bets, panic-exit the prediction portfolio, settle every claimable position, or close out their prediction exposure entirely. ` +
      `Example queries: close all my prediction positions, panic exit prediction portfolio, settle all bets, wipe out my prediction exposure, batch close prediction.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "close all", "batch close", "panic exit",
      "wipe positions", "settle all",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "close all my jupiter prediction positions",
      "panic exit prediction portfolio on solana",
      "batch close prediction bets",
      "wipe out my jupiter predict exposure",
    ],
    preferredFor: ["close all prediction positions", "panic exit prediction", "batch settle bets"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.event": {
    embeddingText: embeddingText(
      `Get a single prediction event with all of its included markets on Solana. ` +
      `Use this when the user wants to see one event (e.g. an election, a sports match) along with every related market it spawns, before picking which specific market to trade. ` +
      `Example queries: get this event with all markets, full event details, markets for this election, all bets for this match, browse one event.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "event by id", "event details", "event markets",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "get this jupiter prediction event with all markets",
      "full event details on solana predict",
      "markets for this election event",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.position": {
    embeddingText: embeddingText(
      `Get one Jupiter prediction position on Solana by public key — open or resolved, contracts, payout, market reference, claimability. ` +
      `Use this when the user wants the deep details on one specific bet, check whether a position is claimable, review the state of one prediction position, or look up a single bet by pubkey. ` +
      `Example queries: details for this prediction position, is this position claimable, status of one bet, look up position by pubkey, full state of one bet.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "position by pubkey", "position details",
      "claimable check", "single bet lookup",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "details for this jupiter prediction position",
      "is this jupiter predict position claimable",
      "look up prediction position by pubkey",
    ],
    chains: SOLANA_CHAINS,
  },
  // ── Pre-trade visibility & order tools (W1-D) ───────────────────

  "solana.predict.orderbook": {
    canonicalSummary:
      "Get bid/ask order-book depth for a Jupiter prediction-market outcome on Solana — YES/NO price levels and sizes.",
    embeddingText: embeddingText(
      `Get order-book depth for a Jupiter prediction market on Solana — YES/NO bid/ask price levels and sizes before placing an order. ` +
      `Use this when the user wants to check market depth, see available liquidity at each price, gauge slippage before betting, or inspect the order book for a market. ` +
      `Example queries: order book for this prediction market, bid ask depth on jupiter predict, liquidity at this price level, market depth before I bet, yes no order book.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "order book", "market depth", "bid ask",
      "price levels", "liquidity depth",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "order book for this jupiter prediction market",
      "bid ask depth on solana predict",
      "market depth before betting on jupiter",
    ],
    preferredFor: ["prediction order book", "prediction market depth"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.tradingStatus": {
    canonicalSummary:
      "Check whether Jupiter Prediction Markets trading is currently active on Solana.",
    embeddingText: embeddingText(
      `Check whether Jupiter Prediction Markets trading is currently active on Solana, before placing a bet. ` +
      `Use this when the user wants to confirm trading is open, check if the exchange is halted, or verify the market is live before submitting an order. ` +
      `Example queries: is jupiter predict trading right now, is trading halted, check trading status before I bet, is the prediction market open.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "trading status", "trading active", "trading halted",
      "exchange status",
    ],
    exampleIntents: [
      "is jupiter prediction trading active",
      "check trading status before betting on solana",
      "is trading halted on jupiter predict",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.orders": {
    canonicalSummary:
      "List a wallet's Jupiter prediction orders on Solana — the buy/sell order lifecycle, not settled positions.",
    embeddingText: embeddingText(
      `List a wallet's Jupiter prediction orders on Solana — pending, filled, or failed buy/sell orders, distinct from open positions. ` +
      `Use this when the user wants to review their order history, check whether an order filled, audit past order submissions, or see order-level detail beyond positions. ` +
      `Example queries: my jupiter prediction orders, did my order fill, list my prediction order history, order lifecycle for my bets.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "my orders", "order history", "order lifecycle",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "list my jupiter prediction orders",
      "did my prediction order fill on solana",
      "order history for my jupiter predict bets",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.order": {
    embeddingText: embeddingText(
      `Get a single Jupiter prediction order on Solana by its pubkey — status, fill price, size, contracts. ` +
      `Use this when the user wants the deep detail on one specific order they placed, check its fill status by pubkey, or look up one order's terms. ` +
      `Example queries: details for this prediction order, look up order by pubkey, status of this specific bet order, order detail on jupiter predict.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "order by pubkey", "order details", "order lookup",
    ],
    exampleIntents: [
      "details for this jupiter prediction order",
      "look up prediction order by pubkey",
      "status of this order on solana predict",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.orderStatus": {
    embeddingText: embeddingText(
      `Get a Jupiter prediction order's durable status and fill-event history on Solana — survives the order account closing after it fills, unlike a direct order lookup. ` +
      `Use this when the user wants to track an order that may have already closed, see its full fill-event history, or confirm final status after the order account is gone. ` +
      `Example queries: order status after it filled, track this order's fill history, confirm my order went through, durable order status lookup.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "order status", "fill history", "durable order lookup",
    ],
    exampleIntents: [
      "check jupiter prediction order status after fill",
      "track order fill history on solana predict",
      "confirm my prediction order went through",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.trades": {
    canonicalSummary:
      "Browse the global Jupiter prediction-market trade feed on Solana — all traders, all markets.",
    embeddingText: embeddingText(
      `Browse the global Jupiter prediction-market trade feed on Solana — every trader's recent buys and sells across every market, not scoped to one wallet. ` +
      `Use this when the user wants to see overall market activity, gauge what other traders are betting on, browse the global prediction trade feed, or check recent platform-wide trades. ` +
      `Example queries: recent trades on jupiter predict, what is everyone betting on, global prediction trade feed, platform-wide prediction activity.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "global trades", "trade feed", "market activity",
      "yes share", "no share", "outcome shares",
    ],
    exampleIntents: [
      "recent trades on jupiter prediction markets",
      "what is everyone betting on solana predict",
      "global prediction trade feed",
    ],
    chains: SOLANA_CHAINS,
  },
  // ── Discovery & social tools (W1-F) ─────────────────────────────

  "solana.predict.profile": {
    embeddingText: embeddingText(
      `Get a trader's aggregate Jupiter prediction-market stats on Solana — realized PnL, total volume, correct and wrong prediction counts. ` +
      `Use this when the user wants their overall prediction track record, lifetime stats, win/loss counts, or total volume traded on Jupiter predict. ` +
      `Example queries: my jupiter prediction stats, my overall prediction track record, how much have I won on predictions, my prediction win rate.`,
    ),
    aliases: [
      "prediction market", "jupiter predict", "trader stats",
      "prediction profile", "track record", "win loss record",
    ],
    exampleIntents: [
      "my jupiter prediction trader stats",
      "overall prediction track record on solana",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.pnlHistory": {
    embeddingText: embeddingText(
      `Get a wallet's realized-PnL time series on Jupiter prediction markets on Solana over an interval (24 hours, 1 week, or 1 month). ` +
      `Use this when the user wants to chart their prediction PnL over time, see how their prediction performance has trended, or review historical realized PnL by period. ` +
      `Example queries: my prediction pnl over time, chart my jupiter predict earnings, pnl history for the last week, how has my prediction performance trended.`,
    ),
    aliases: [
      "prediction market", "jupiter predict", "pnl history",
      "pnl over time", "pnl chart", "realized pnl",
    ],
    exampleIntents: [
      "my jupiter prediction pnl history",
      "chart my prediction earnings over a week",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.leaderboards": {
    canonicalSummary:
      "Get ranked Jupiter prediction-market traders on Solana by period and metric — PnL, volume, or win rate.",
    embeddingText: embeddingText(
      `Get ranked Jupiter prediction-market traders on Solana by period (all-time, weekly, monthly) and metric (PnL, volume, or win rate). ` +
      `Use this when the user wants to see top prediction traders, check the leaderboard, compare their performance to other traders, or find the best predictors this week. ` +
      `Example queries: top jupiter prediction traders, prediction leaderboard this week, who has the best pnl on predictions, top predictors by volume.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "leaderboard", "top traders", "rankings",
      "top predictors",
    ],
    exampleIntents: [
      "top jupiter prediction traders this week",
      "prediction leaderboard by pnl",
      "who has the best win rate on solana predict",
    ],
    preferredFor: ["prediction leaderboard", "top prediction traders"],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.vaultInfo": {
    embeddingText: embeddingText(
      `Get the Jupiter prediction-market vault's on-chain public key and balance on Solana. ` +
      `Use this when the user wants to check the prediction vault's balance, verify the vault account, or inspect protocol-level vault state. ` +
      `Read-only protocol infrastructure lookup: it takes no wallet or position parameters and returns the vault account identity with its current balance. ` +
      `Example queries: jupiter prediction vault balance, prediction vault pubkey, check the predict vault state, inspect the jupiter prediction vault account.`,
    ),
    aliases: [
      "prediction market", "jupiter predict",
      "vault info", "vault balance", "vault state",
    ],
    exampleIntents: [
      "jupiter prediction vault balance",
      "check the predict vault state on solana",
    ],
    chains: SOLANA_CHAINS,
  },

  "solana.predict.suggestedEvents": {
    embeddingText: embeddingText(
      `Get personalized Jupiter prediction-market event recommendations for a wallet pubkey on Solana. ` +
      `Use this when the user wants event suggestions tailored to a wallet, personalized prediction picks, or recommended markets based on a pubkey's activity. ` +
      `Read-only discovery feed: pass an explicit wallet pubkey and receive suggested prediction events ranked for that address. ` +
      `Example queries: suggested prediction events for my wallet, recommended jupiter predict markets, personalized prediction picks, events suggested for this pubkey.`,
    ),
    aliases: [
      "prediction market", "jupiter predict", "suggested events",
      "recommended markets", "personalized picks",
    ],
    exampleIntents: [
      "suggested jupiter prediction events for my wallet",
      "recommended prediction markets on solana",
    ],
    chains: SOLANA_CHAINS,
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 22;
if (Object.keys(SOLANA_PREDICT_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `SOLANA_PREDICT_DISCOVERY has ${Object.keys(SOLANA_PREDICT_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
