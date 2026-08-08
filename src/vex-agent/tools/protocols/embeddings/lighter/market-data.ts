import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";

export const LIGHTER_MARKET_DATA_DISCOVERY = {
  "lighter.system": {
    embeddingText: embeddingText(
      `Read public Lighter system status and exchange configuration for Core or Robinhood Chain, including network id, status timestamp, public pool indexes, cooldown periods, and integrator fee ceilings. ` +
      `Use when: the user asks whether Lighter is reachable, which environment is live, or wants configuration context before market reads. ` +
      `Returns compact status and config fields only; it never reads accounts or credentials. ` +
      `Example queries: lighter system status, is rhc lighter up, lighter core config, public fee limits on lighter.`,
    ),
    aliases: ["lighter status", "lighter system config", "rhc status", "core status"],
    exampleIntents: ["lighter system status", "is rhc lighter up", "lighter core config"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.markets": {
    embeddingText: embeddingText(
      `List public Lighter markets and order books on Core or Robinhood Chain, with optional market id and spot or perpetual filtering plus a bounded result cap. ` +
      `Use when: the user wants to find Lighter market ids, inspect available symbols, compare spot and perp markets, or choose the market for later depth, trades, or candles. ` +
      `Returns concise market rows: symbol, ids, status, fee strings, minimum order amounts, decimals, and truncation disclosure. ` +
      `Example queries: list lighter markets, find btc market id on rhc, lighter spot markets, lighter perp symbols.`,
    ),
    aliases: ["lighter markets", "lighter symbols", "market ids", "order books list"],
    exampleIntents: ["list lighter markets", "find btc market id on rhc", "lighter spot markets"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.market.get": {
    embeddingText: embeddingText(
      `Get detailed public metadata for one Lighter market on Core or Robinhood Chain by numeric market id, including daily activity, last trade price, fee settings, decimal metadata, funding fields, and status. ` +
      `Use when: the user already has a Lighter market id and wants one-market context before reading depth, trades, candles, or planning future order support. ` +
      `Returns one or more matching detail rows and fails clearly if the market id is not found. ` +
      `Example queries: lighter market 0 detail, get eth perp on core, details for rhc market id 1.`,
    ),
    aliases: ["lighter market detail", "market metadata", "market id lookup", "lighter market get"],
    exampleIntents: ["lighter market 0 detail", "details for rhc market id 1", "get eth perp on core"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.orderbook": {
    embeddingText: embeddingText(
      `Read resting Lighter order book orders for one market on Core or Robinhood Chain, with a strict visible depth cap on each side. ` +
      `Use when: the user wants current bid and ask depth, top levels, spread context, or liquidity around a market before making a decision. ` +
      `Returns public ask and bid order rows with price, remaining size, owner account index, totals, and truncation flags. ` +
      `Example queries: lighter order book for market 0, rhc bid ask depth, top asks on lighter btc market.`,
    ),
    aliases: ["lighter order book", "lighter depth", "bid ask", "market depth"],
    exampleIntents: ["lighter order book for market 0", "rhc bid ask depth", "top asks on lighter btc market"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.recentTrades": {
    embeddingText: embeddingText(
      `Read the recent public trade tape for one Lighter market on Core or Robinhood Chain, with a bounded row limit and cursor disclosure when the provider supplies one. ` +
      `Use when: the user wants latest fills, trade prices, sizes, maker side, or short-term activity before reading candles or depth. ` +
      `Returns trade id, price, size, USD amount, maker side, accounts, block height, timestamps, and transaction hash. ` +
      `Example queries: recent trades on lighter market 0, latest rhc fills, trade tape for core eth market.`,
    ),
    aliases: ["lighter recent trades", "trade tape", "latest fills", "lighter fills"],
    exampleIntents: ["recent trades on lighter market 0", "latest rhc fills", "trade tape for core eth market"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.candles": {
    embeddingText: embeddingText(
      `Read OHLCV candles for one Lighter market on Core or Robinhood Chain using epoch-millisecond start and end timestamps, a closed resolution set, and bounded countBack. ` +
      `Use when: the user asks for chart history, recent price movement, volatility, or candle data for a known Lighter market id. ` +
      `Returns newest candle rows up to the agent output cap, plus provider row count and truncation disclosure. ` +
      `Example queries: lighter 1h candles for market 0, rhc price history, chart btc lighter market, recent core candles.`,
    ),
    aliases: ["lighter candles", "lighter ohlcv", "price history", "market chart"],
    exampleIntents: ["lighter 1h candles for market 0", "rhc price history", "chart btc lighter market"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 6;
if (Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `LIGHTER_MARKET_DATA_DISCOVERY has ${Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
