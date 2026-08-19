import type { ToolDiscoveryMetadata } from "../../types.js";
import { embeddingText } from "../../_embedding-text.js";

export const LIGHTER_MARKET_DATA_DISCOVERY = {
  "lighter.account.onboarding.status": {
    embeddingText: embeddingText(
      `Check whether the selected Vex wallet is ready to trade on Lighter. Unspecified conversational requests default to Robinhood Chain; use Core only when explicitly selected, and keep that environment in later calls. ` +
      `Use when: setup, funding, readiness, or a perp request needs checking. Pass the requested market so Vex checks its live minimum. Reads wallet settlement balance, Lighter collateral, deposit minimum, and public key state. It signs and moves nothing. ` +
      `Example queries: set up my Lighter account, can this wallet trade on Lighter, fund Lighter for a 2 USDC trade.`,
    ),
    aliases: ["lighter onboarding status", "lighter account readiness", "can I trade on lighter", "trade on lighter", "lighter wallet setup", "set up lighter account", "lighter perps setup"],
    exampleIntents: ["set up my Lighter account", "I need to trade on Lighter", "get me ready to trade on Lighter", "I want to trade perps on Lighter"],
    ecosystems: ["lighter", "robinhood-chain", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
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
      `Create a read-only Lighter Phase 1 IOC market-order preview using live market detail, order book, and account data. ` +
      `Use when: the user asks to preview or check an IOC market order without placing it. Price is the worst acceptable execution price. Resting limit and post-only orders are unavailable. Pass named assets as market symbols. Unspecified requests default to RHC; preserve Core or RHC after selection. ` +
      `Returns exact amounts, minimum checks, best bid/ask, position context, and risk notes. Never signs or submits. ` +
      `Example queries: preview an IOC market buy of 0.001 ETH with worst price 3000, preflight an RHC market buy.`,
    ),
    aliases: ["lighter order preview", "preview order", "order preflight", "lighter_order"],
    exampleIntents: ["show me an IOC market buy preview for 0.001 ETH with worst price 3000", "preview lighter market order", "preflight rhc market buy", "check core reduce-only market sell"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.order.create.prepare": {
    embeddingText: embeddingText(
      `Prepare an approval-gated Lighter order create from a fresh persisted preview and opaque encrypted-vault credential reference. ` +
      `Use when: the user has previewed an order and says to prepare it, create it, or send it for approval. Use the latest fresh preview when no preview id is specified; Vex derives the vault reference from preview environment, account, and API-key index. ` +
      `Creates durable execution intent state and an approval card. It never reads private-key bytes, signs, submits, or calls sendTx. ` +
      `Example queries: prepare that order for approval, ready latest preview.`,
    ),
    aliases: ["lighter create prepare", "lighter order approval", "prepare order create", "approval gated lighter order"],
    exampleIntents: ["prepare that lighter order for approval", "create that RHC order after approval", "ready the latest lighter preview for order create"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.order.create": {
    embeddingText: embeddingText(
      `Approval-gated Lighter order create resume target for a prepared execution intent. ` +
      `Use when: the trusted approval follow-up from lighter.order.create.prepare resumes after the user approves. Direct model calls without a prepared intent and approval-resume context are refused. ` +
      `After exact host approval, the privileged runtime revalidates the live credential, account, nonce, and order before local signing and submission. ` +
      `Example queries: execute approved lighter order intent, resume lighter order create approval.`,
    ),
    aliases: ["lighter order create", "approved lighter order", "lighter order intent execute"],
    exampleIntents: ["execute approved lighter order intent", "resume lighter order create approval"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.withdraw.prepare": {
    embeddingText: embeddingText(
      `Prepare an exact secure withdrawal from the selected wallet's Lighter account: Core USDC to Ethereum or RHC USDG to Robinhood Chain. ` +
      `Use when: the user asks to withdraw, cash out, or move Lighter collateral back to their wallet. Pass the explicit environment and human-decimal amount; Vex resolves the account and local credential and refuses destination, route, ownership, margin, gateway, or unresolved-state ambiguity. ` +
      `Returns a durable intent and trusted approval card after live preflight; preparation signs and moves nothing. ` +
      `Example queries: withdraw 2 USDC from Lighter Core, withdraw 5 USDG from Lighter RHC.`,
    ),
    aliases: ["withdraw from lighter", "lighter core withdrawal", "withdraw usdc", "cash out lighter"],
    exampleIntents: ["withdraw 2 USDC from Lighter Core", "move my Core collateral back to my wallet"],
    ecosystems: ["lighter", "ethereum", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.withdraw": {
    embeddingText: embeddingText(
      `Execute one exact prepared Core USDC or RHC USDG secure withdrawal only after its trusted approval resumes. ` +
      `Use when: the host approval created by lighter.withdraw.prepare has been approved; direct model calls are refused. Vex revalidates the selected environment, owner, collateral, gateway, local credential, and shared nonce, stages durable transaction identity, and submits once. ` +
      `Returns submitted hashes and provider acceptance or an ambiguous state; final delivery still requires Lighter and destination-chain proof, and uncertain outcomes are never retried. ` +
      `Example queries: execute the approved Lighter withdrawal, resume my approved RHC USDG withdrawal.`,
    ),
    aliases: ["approved lighter withdrawal", "execute core usdc withdrawal"],
    exampleIntents: ["execute the approved Lighter Core withdrawal"],
    ecosystems: ["lighter", "ethereum", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.withdraw.status": {
    embeddingText: embeddingText(
      `Check and reconcile a submitted Core USDC or RHC USDG withdrawal without signing, submitting, or retrying it. ` +
      `Use when: the withdrawal is pending, claimable, completed, ambiguous, or the user asks whether funds reached Ethereum or Robinhood Chain. It joins the exact Lighter transaction and history with gateway balance, event, token transfer, canonical block, and confirmation evidence. ` +
      `Returns durable execution, claim, destination, confirmation, and next-action state; provider labels alone are never final delivery. ` +
      `Example queries: check my Lighter withdrawal, did my RHC USDG reach my wallet.`,
    ),
    aliases: ["lighter withdrawal status", "check usdc withdrawal", "is lighter withdrawal complete"],
    exampleIntents: ["check my Lighter Core withdrawal", "did my USDC reach Ethereum"],
    ecosystems: ["lighter", "ethereum", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.withdraw.claim.prepare": {
    embeddingText: embeddingText(
      `Prepare a separate wallet approval to claim one exact Core USDC or RHC USDG withdrawal that reconciliation has proven claimable. ` +
      `Use when: lighter.withdraw.status reports the exact withdrawal as claimable. Vex rechecks the reviewed environment-specific gateway, fixed owner, exact pending amount, zero-value transaction data, simulation, ETH balance, and fresh network-fee ceiling. ` +
      `Returns a durable claim id, amount, network, fee ceiling, expiry, and separate host approval card; it never signs or broadcasts. ` +
      `Example queries: prepare my pending Lighter claim, claim my RHC USDG withdrawal.`,
    ),
    aliases: ["prepare lighter withdrawal claim", "claim core usdc", "manual lighter claim"],
    exampleIntents: ["prepare the claim for my Core USDC withdrawal", "claim my pending lighter USDC"],
    ecosystems: ["lighter", "ethereum", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.withdraw.claim": {
    embeddingText: embeddingText(
      `Execute one separately approved Core USDC or RHC USDG gateway claim on its settlement network. ` +
      `Use when: the host approval created by lighter.withdraw.claim.prepare resumes; direct model calls are refused. Vex revalidates the fixed owner, exact pending balance, reviewed contract identity, and approved network-fee ceiling, then stages the transaction hash before one broadcast and never retries ambiguity. ` +
      `Returns the claim hash and confirming or ambiguous state; final delivery still requires exact event, transfer, canonical block, zero pending balance, and 12 confirmations. ` +
      `Example queries: execute my approved Lighter claim, resume the approved RHC USDG claim.`,
    ),
    aliases: ["execute lighter withdrawal claim", "approved core usdc claim"],
    exampleIntents: ["execute the approved Core USDC claim"],
    ecosystems: ["lighter", "ethereum", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.deposit.prepare": {
    embeddingText: embeddingText(
      `Prepare a separately approval-gated Lighter Core deposit from the selected Vex EVM wallet into that same wallet's Lighter account. ` +
      `Use when: managed onboarding validates an explicit deposit amount or returns prepare_deposit for the exact trade shortfall. Never use it for below_lighter_deposit_minimum or insufficient_wallet_settlement_asset. The host card is the consent surface. Preparation creates durable intent state but does not read a private key, sign, broadcast, or move funds. ` +
      `Example queries: deposit 11 USDC to set up Lighter, fund my Lighter account with 5 USDC, use 20 USDC for Lighter perps.`,
    ),
    aliases: ["lighter deposit prepare", "fund lighter", "lighter account deposit", "onboard lighter wallet", "deposit for lighter setup"],
    exampleIntents: ["deposit 11 USDC to set up Lighter", "fund my Lighter account with 5 USDC", "use 20 USDC for Lighter perps"],
    ecosystems: ["lighter", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.key.register.prepare": {
    embeddingText: embeddingText(
      `Prepare a separate approval for registering a locally encrypted Lighter trading credential on the selected Vex-wallet-owned Core account. ` +
      `Use when: managed onboarding has resolved the selected wallet's funded account and secure trading setup remains. Vex reserves a full-read-proven free slot, generates and encrypts the key in the privileged process, and creates an exact approval card without asking the user for account, slot, nonce, fingerprint, or key material. ` +
      `Example queries: finish my Lighter setup, complete secure Lighter trading access, get my funded Lighter account ready to trade.`,
    ),
    aliases: ["lighter key registration", "register lighter api key", "lighter trading key setup"],
    exampleIntents: ["finish my Lighter setup", "complete secure Lighter trading access", "get my funded Lighter account ready to trade"],
    ecosystems: ["lighter", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.key.register": {
    embeddingText: embeddingText(
      `Execute one exact prepared Lighter key registration after the trusted host approval resumes. ` +
      `Use when: only the trusted host approval runtime resumes the matching key-registration card. Direct calls are refused. Main signs and submits the exact TxType 8 registration, then requires exact key, CheckClient, and nonce evidence before activation. ` +
      `Example queries: execute approved Lighter key registration, resume Lighter key approval.`,
    ),
    aliases: ["approved lighter key registration", "lighter key register execute"],
    exampleIntents: ["execute approved Lighter key registration", "resume Lighter key approval"],
    ecosystems: ["lighter", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.key.register.status": {
    embeddingText: embeddingText(
      `Reconcile an already-staged Lighter key registration from exact public provider evidence without signing or resubmitting. ` +
      `Use when: an approved registration returned submitted_pending_verification, ambiguity_unresolved, registered_key_conflict, or key_verified_pending_nonce. It can verify the exact slot, run official CheckClient, synchronize nonce +1, and activate the encrypted key, but structurally refuses an unstaged approved intent. ` +
      `Example queries: check my Lighter key registration, reconcile Lighter API key setup, is my Lighter trading key active.`,
    ),
    aliases: ["lighter key registration status", "reconcile lighter api key", "lighter trading key active"],
    exampleIntents: ["check my Lighter key registration", "reconcile Lighter API key setup", "is my Lighter trading key active"],
    ecosystems: ["lighter", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.deposit": {
    embeddingText: embeddingText(
      `Approval-resume target for one exact prepared Lighter Core deposit. ` +
      `Use when: only the trusted approval runtime is resuming the exact deposit card the user approved. It can securely sign and broadcast Ethereum approval and deposit transactions, so it must never be called directly or used as a status check. ` +
      `Example queries: execute approved Lighter deposit intent, resume Lighter deposit approval.`,
    ),
    aliases: ["approved lighter deposit", "lighter deposit execute", "resume lighter funding approval"],
    exampleIntents: ["execute approved Lighter deposit intent", "resume Lighter deposit approval"],
    ecosystems: ["lighter", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.deposit.status": {
    embeddingText: embeddingText(
      `Inspect this Vex wallet's durable Lighter deposit intent state without signing or broadcasting. ` +
      `Use when: a deposit is pending or ambiguous, the user asks what happened, or a new deposit is blocked by an unresolved intent. Returns staged transaction hashes, execution state, credited account index when known, and safe next-action guidance. It never retries or replaces a transaction. ` +
      `Example queries: what happened to my Lighter deposit, check Lighter funding status, is my Lighter deposit stuck.`,
    ),
    aliases: ["lighter deposit status", "lighter funding status", "lighter deposit stuck", "check lighter deposit"],
    exampleIntents: ["what happened to my Lighter deposit", "check Lighter funding status", "is my Lighter deposit stuck"],
    ecosystems: ["lighter", "ethereum"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.order.status": {
    embeddingText: embeddingText(
      `Check and reconcile the true state of Vex-submitted Lighter orders from provider evidence and provable nonce facts. ` +
      `Use when: an order create ended sequencer_pending or ambiguous, the user asks what happened to a Lighter order, or a new order is blocked by an unresolved nonce reservation. ` +
      `Returns per-intent repair reports with state before and after, evidence source, nonce blockage, and wait-or-resolved guidance. It never signs, submits, retries, or cancels an order. ` +
      `Example queries: what happened to my lighter order, is my rhc order stuck, unblock lighter nonce.`,
    ),
    aliases: ["lighter order status", "lighter order stuck", "lighter order repair", "lighter nonce blocked"],
    exampleIntents: ["what happened to my lighter order", "is my rhc order stuck", "unblock the lighter nonce reservation"],
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

const EXPECTED_COUNT = 28;
if (Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `LIGHTER_MARKET_DATA_DISCOVERY has ${Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
