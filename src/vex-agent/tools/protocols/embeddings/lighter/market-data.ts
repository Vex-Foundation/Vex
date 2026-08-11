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
  "lighter.account.get": {
    embeddingText: embeddingText(
      `Read public Lighter account state on Core or Robinhood Chain by account index or L1 address, including collateral, available balance, assets, and inline positions when the provider includes them. ` +
      `Use when: the user asks to inspect a Lighter account, check account state, find public balances, or review account-level data without credentials. ` +
      `This is public provider data from the account endpoint; it does not prove private authenticated access and never uses a token, wallet, signer, or order path. ` +
      `Example queries: get lighter account 42, inspect rhc account by address, lighter account balance.`,
    ),
    aliases: ["lighter account", "lighter account get", "account state", "lighter balances"],
    exampleIntents: ["get lighter account 42", "inspect rhc account by address", "lighter account balance"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.positions": {
    embeddingText: embeddingText(
      `Read public Lighter positions exposed on the account payload for Core or Robinhood Chain by account index or L1 address, with bounded account and position rows. ` +
      `Use when: the user asks for positions, exposure, open account holdings, or account market state visible through Lighter's public account endpoint. ` +
      `This is public provider data and must not be described as authenticated private account visibility unless a later auth-gated tool proves that path. ` +
      `Example queries: lighter positions for account 42, rhc account exposure, core positions by wallet address.`,
    ),
    aliases: ["lighter positions", "account positions", "lighter exposure", "rhc positions"],
    exampleIntents: ["lighter positions for account 42", "rhc account exposure", "core positions by wallet address"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.openOrders": {
    embeddingText: embeddingText(
      `Read authenticated Lighter open orders for the account authorized by a read-only token on Core or Robinhood Chain, optionally filtered by market id and market type. ` +
      `Use when: the user asks for their current resting orders, active orders, open bids or asks, or order exposure. ` +
      `Requires a Lighter read-only auth token; defaults to the token's account and refuses mismatched single-account tokens. It never places, cancels, signs, deposits, or withdraws. ` +
      `Example queries: my lighter open orders, rhc active orders for market 0, core open bids.`,
    ),
    aliases: ["lighter open orders", "active orders", "my orders", "resting orders"],
    exampleIntents: ["my lighter open orders", "rhc active orders for market 0", "core open bids"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.orderHistory": {
    embeddingText: embeddingText(
      `Read authenticated Lighter inactive order history for the account authorized by a read-only token on Core or Robinhood Chain, with bounded rows and exact order identifiers. ` +
      `Use when: the user asks for filled, cancelled, inactive, or historical orders. ` +
      `Requires a Lighter read-only auth token; defaults to the token's account and refuses mismatched single-account tokens. It is read-only and cannot submit or cancel orders. ` +
      `Example queries: lighter order history, rhc filled orders, cancelled core lighter orders.`,
    ),
    aliases: ["lighter order history", "inactive orders", "filled orders", "cancelled orders"],
    exampleIntents: ["lighter order history", "rhc filled orders", "cancelled core lighter orders"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.trades": {
    embeddingText: embeddingText(
      `Read authenticated Lighter account trade history for the account authorized by a read-only token on Core or Robinhood Chain, with bounded rows and exact provider string ids. ` +
      `Use when: the user asks for their account fills, personal trade history, executed trades, or account-level fills rather than the public market tape. ` +
      `Requires a Lighter read-only auth token; defaults to the token's account and refuses mismatched single-account tokens. It is read-only and cannot place, cancel, or sign. ` +
      `Example queries: my lighter trades, rhc account fills, core executed trades.`,
    ),
    aliases: ["lighter account trades", "my trades", "account fills", "lighter fills"],
    exampleIntents: ["my lighter trades", "rhc account fills", "core executed trades"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.apiKeys.inspect": {
    embeddingText: embeddingText(
      `Read public Lighter API-key metadata for one account on Core or Robinhood Chain, including API key indexes, public keys, current nonce values, and transaction timestamps. ` +
      `Use when: the user asks which Lighter API-key indexes exist, what nonce a future order signer would need to reconcile, or wants public key metadata before execution architecture work. ` +
      `This endpoint is public provider data; it never reads an API private key, never mints an auth token, never signs, never submits, and cannot place or cancel orders. ` +
      `Example queries: inspect lighter api keys, get rhc api key nonce, list core lighter api key indexes.`,
    ),
    aliases: ["lighter api keys", "api key nonce", "lighter nonce", "api key index"],
    exampleIntents: ["inspect lighter api keys", "get rhc api key nonce", "list core lighter api key indexes"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.order.preview": {
    embeddingText: embeddingText(
      `Create a read-only Lighter order preview for Core or Robinhood Chain using live market detail, live order book, and live account data before any future order approval or submission. ` +
      `Use when: the user asks to preview, preflight, check, or prepare a Lighter limit or market order without placing it. ` +
      `Returns a session-scoped preview id, exact identity hash, integer base amount and price, minimum checks, best bid and ask, position context, and risk notes. ` +
      `This never signs, submits, places, cancels, deposits, withdraws, transfers, or calls sendTx. Example queries: preview lighter order, preflight rhc buy order, check core reduce-only sell.`,
    ),
    aliases: ["lighter order preview", "preview order", "order preflight", "lighter_order"],
    exampleIntents: ["preview lighter order", "preflight rhc buy order", "check core reduce-only sell"],
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

const EXPECTED_COUNT = 13;
if (Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `LIGHTER_MARKET_DATA_DISCOVERY has ${Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
