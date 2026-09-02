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
      `Create a live Lighter order preview for a native limit-family order: limit, stop-loss-limit, take-profit-limit, market, stop-loss, or take-profit. ` +
      `Use when the user requests an IOC market order, resting GTT limit, maker-only post-only limit, or perpetual protection. Require explicit time in force: limit, stop-loss-limit, and take-profit-limit support IOC, GTT, or post-only; market, stop-loss, and take-profit require IOC. Protective orders require reduce-only, an exact trigger, price bound, reducing side, and size. ` +
      `Returns exact preview terms and a separate approval card when ready; it never signs without approval. Example queries: prepare trade approval; GTT ETH limit bid; post-only ETH bid; GTT stop-loss-limit; GTT take-profit-limit.`,
    ),
    aliases: ["lighter order preview", "preview order", "order preflight", "lighter limit order", "lighter post only", "lighter stop loss limit", "lighter take profit limit", "lighter_order"],
    exampleIntents: ["show me an IOC market buy preview for 0.001 ETH with worst price 3000", "place a good-till-time Lighter limit bid", "make my Lighter limit order post-only", "protect my lighter long with a GTT stop-loss-limit", "take profit on my rhc ETH position with a GTT take-profit-limit"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
  "lighter.position.protect": {
    embeddingText: embeddingText(
      `Preview and prepare native Lighter OCO protection for one existing perpetual position using exactly one reduce-only stop-loss and one same-size reduce-only take-profit. ` +
      `Use when: the user wants both a stop loss and take profit on an existing Lighter long or short. Require exact size, reducing side, both trigger prices, both hard execution bounds, and expiry; never guess. This does not open a position and does not support entry-plus-protection, OTO, or OTOCO. ` +
      `After one exact approval, Vex signs and submits one native Lighter grouped transaction. It reports active protection only after both exact children are visible from authenticated provider evidence, never emulates cancellation, and never retries uncertainty. ` +
      `Example queries: protect my 0.1 ETH Lighter long with stop 2900 bound 2850 and take profit 3300 bound 3250, add stop loss and take profit to my RHC perp position.`,
    ),
    aliases: ["lighter oco", "lighter stop loss and take profit", "protect lighter position", "paired tp sl"],
    exampleIntents: ["protect my Lighter long with a stop loss and take profit", "add native OCO to my RHC perp position"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
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
  "lighter.order.cancel.prepare": {
    embeddingText: embeddingText(
      `Prepare an approval-gated cancellation for one exact active Lighter order. ` +
      `Use when: the user identifies an open order by its provider order id and asks to cancel it. Vex resolves the saved account credential, reads the exact active order with authenticated provider access, and binds its string order id, market, side, price, remaining amount, fills, and status into a durable intent and approval card. ` +
      `Preparation never reads private-key bytes, reserves a nonce, signs, or submits. ` +
      `Example queries: cancel Lighter order 123 on market 0, prepare cancellation for my open RHC order.`,
    ),
    aliases: ["lighter cancel order", "cancel open order", "prepare order cancellation"],
    exampleIntents: ["cancel Lighter order 123 on market 0", "prepare cancellation for that open RHC order"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.order.cancel": {
    embeddingText: embeddingText(
      `Execute one exact prepared Lighter order cancellation after approval. ` +
      `Use when: the trusted approval card from lighter.order.cancel.prepare resumes. The privileged runtime re-reads the exact active provider order, credential, and nonce; persists structural identity before one TxType 15 submission; never retries ambiguity; and reports canceled only from exact inactive-order evidence. ` +
      `Direct model calls without the matching approval are refused. Example queries: execute the approved Lighter cancellation, resume my approved order cancel.`,
    ),
    aliases: ["execute lighter cancellation", "approved order cancel"],
    exampleIntents: ["execute approved Lighter order cancellation"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.order.modify.prepare": {
    embeddingText: embeddingText(
      `Prepare an approval-gated modification for one exact active Lighter limit order. ` +
      `Use when: the user identifies an open provider order id and explicitly requests a replacement total size and/or price. Vex reads live market precision and authenticated order state, refuses a total below already-filled size, and binds the original and requested values into a durable approval card. ` +
      `Preparation never reads private-key bytes, reserves a nonce, signs, or submits. Example queries: modify my Lighter order to 0.01 at 2500, change this Lighter limit price.`,
    ),
    aliases: ["prepare lighter order modification", "change lighter limit price", "resize lighter order"],
    exampleIntents: ["modify my Lighter order to 0.01 at 2500", "change this Lighter limit order price"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.order.modify": {
    embeddingText: embeddingText(
      `Execute one exact prepared Lighter order modification after approval. ` +
      `Use when: the trusted approval card from lighter.order.modify.prepare resumes. The privileged runtime revalidates exact order state, market precision, credential, and nonce; persists structural identity before one TxType 17 submission; never retries ambiguity; and reports completion only from exact updated provider evidence. ` +
      `Direct model calls without the matching approval are refused. Example queries: execute the approved Lighter modification, resume my approved order change.`,
    ),
    aliases: ["execute lighter modification", "approved order modify"],
    exampleIntents: ["execute approved Lighter order modification"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.order.cancelAll.prepare": {
    embeddingText: embeddingText(
      `Prepare one explicit approval to immediately cancel every active Lighter order in one saved account across all markets. ` +
      `Use when: the user clearly asks to cancel all open Lighter orders. Vex reads and binds the complete exact active-order set and refuses execution if any order changes before submission. ` +
      `Preparation never reads private-key bytes, reserves a nonce, signs, or submits. Example queries: cancel all my Lighter orders, clear every open order on RHC Lighter.`,
    ),
    aliases: ["prepare lighter cancel all", "cancel every lighter order", "clear lighter open orders"],
    exampleIntents: ["cancel all my Lighter orders", "prepare to clear every open order on RHC Lighter"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.order.cancelAll": {
    embeddingText: embeddingText(
      `Execute one exact immediate account-wide Lighter cancellation after approval. ` +
      `Use when: the trusted approval card from lighter.order.cancelAll.prepare resumes. The privileged runtime requires the exact active set to remain unchanged, signs immediate TxType 16 once, never retries ambiguity, and reports completion only when no active orders remain and every approved order has exact terminal evidence. ` +
      `Direct model calls without the matching approval are refused. Example queries: execute approved Lighter cancel all, resume clearing all approved orders.`,
    ),
    aliases: ["execute lighter cancel all", "approved cancel every order"],
    exampleIntents: ["execute approved Lighter cancel all"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "high",
  },
  "lighter.position.close.prepare": {
    embeddingText: embeddingText(
      `Prepare an approval-gated close of the entire current position in one Lighter perpetual market. ` +
      `Use when: the user explicitly asks to close a specific long or short and supplies a maximum slippage ceiling. Vex reads the exact live position, market precision, and visible book depth, then binds a full-size reduce-only market IOC order at a worst acceptable price. ` +
      `Preparation never reads private-key bytes, reserves a nonce, signs, or submits. Example queries: close my Lighter ETH position with 100 bps max slippage, prepare my full RHC position close.`,
    ),
    aliases: ["prepare lighter position close", "close lighter long", "close lighter short"],
    exampleIntents: ["close my Lighter ETH position with 100 bps max slippage"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "low",
  },
  "lighter.position.close": {
    embeddingText: embeddingText(
      `Execute one exact prepared Lighter position close after approval. ` +
      `Use when: the trusted approval card from lighter.position.close.prepare resumes. The privileged runtime revalidates position and depth, submits one full-size reduce-only market IOC order, never retries ambiguity, and reports exact fill, average fill price, and resulting position. ` +
      `Direct model calls without the matching approval are refused. Example queries: execute the approved Lighter position close, resume my approved full close.`,
    ),
    aliases: ["execute lighter close", "approved position close"],
    exampleIntents: ["execute approved Lighter position close"],
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
      `Check and reconcile the true state of Vex-submitted Lighter create orders, cancels, modifications, cancel-all actions, and reduce-only position closes from exact order, trade, position, and nonce evidence. ` +
      `Use when: any Lighter action ended sequencer_pending or ambiguous, the user asks what happened, or a new action is blocked by an unresolved nonce reservation. ` +
      `Returns per-intent state, exact fills and resulting position when available, nonce blockage, and safe guidance. It never signs, submits, retries, cancels, or modifies anything. ` +
      `Example queries: what happened to my lighter close, is my rhc cancel stuck, check lighter modification, unblock lighter nonce.`,
    ),
    aliases: ["lighter order status", "lighter lifecycle status", "lighter close status", "lighter cancel stuck", "lighter order repair", "lighter nonce blocked"],
    exampleIntents: ["what happened to my lighter close", "is my rhc cancel stuck", "check my lighter modification", "unblock the lighter nonce reservation"],
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
      `Returns provider rows bounded by countBack and the newest projected rows, plus provider row count and truncation disclosure. ` +
      `Example queries: lighter 1h candles for market 0, rhc price history, chart btc lighter market, recent core candles.`,
    ),
    aliases: ["lighter candles", "lighter ohlcv", "price history", "market chart"],
    exampleIntents: ["lighter 1h candles for market 0", "rhc price history", "chart btc lighter market"],
    ecosystems: ["lighter", "robinhood-chain"],
    sourceClass: "protocol_native",
    sideEffectLevel: "none",
  },
} satisfies Record<string, ToolDiscoveryMetadata>;

const EXPECTED_COUNT = 37;
if (Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length !== EXPECTED_COUNT) {
  throw new Error(
    `LIGHTER_MARKET_DATA_DISCOVERY has ${Object.keys(LIGHTER_MARKET_DATA_DISCOVERY).length} entries, expected ${EXPECTED_COUNT}.`,
  );
}
