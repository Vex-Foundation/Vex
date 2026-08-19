import {
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_DEFAULT_ENVIRONMENT,
  LIGHTER_ENVIRONMENTS,
  LIGHTER_MARKET_FILTERS,
} from "@tools/lighter/constants.js";
import {
  LIGHTER_ORDER_SIDES,
  LIGHTER_ORDER_TIME_IN_FORCE,
  LIGHTER_ORDER_TYPES,
} from "@tools/lighter/order-preview.js";
import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { LIGHTER_MARKET_DATA_DISCOVERY } from "../../embeddings/lighter/market-data.js";
import {
  LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
  LIGHTER_AGENT_ACCOUNT_POSITION_MAX,
  LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT,
  LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_MAX,
  LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT,
  LIGHTER_AGENT_API_KEY_LIMIT_MAX,
  LIGHTER_AGENT_ACCOUNT_ROW_MAX,
  LIGHTER_AGENT_MARKET_LIMIT_DEFAULT,
  LIGHTER_AGENT_MARKET_LIMIT_MAX,
  LIGHTER_AGENT_MARKET_PAGE_MAX,
  LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT,
  LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX,
  LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX,
  LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN,
  LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT,
  LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX,
} from "../params.js";

const ENVIRONMENT_PARAM: ProtocolParamDef = {
  key: "environment",
  type: "string",
  enum: LIGHTER_ENVIRONMENTS,
  description:
    `Optional public Lighter environment to read: core for Lighter Core, rhc for Robinhood Chain. Defaults to ${LIGHTER_DEFAULT_ENVIRONMENT} for conversational Lighter requests. Any other value is rejected.`,
};

const MARKET_ID_REQUIRED_PARAM: ProtocolParamDef = {
  key: "marketId",
  type: "number",
  required: true,
  description:
    "Numeric Lighter market id from lighter.markets, as an integer from 0 to 65535. It names the order book to read.",
};

const MARKET_ID_OPTIONAL_PARAM: ProtocolParamDef = {
  ...MARKET_ID_REQUIRED_PARAM,
  required: false,
  description:
    "Optional numeric Lighter market id from lighter.markets. When omitted, the market list reads the environment's visible markets.",
};

const MARKET_SYMBOL_PARAM: ProtocolParamDef = {
  key: "marketSymbol",
  type: "string",
  description:
    "Optional market symbol such as ETH. Use this for conversational order previews when the user names an asset instead of a market id; Vex resolves it against live Lighter markets.",
};

const MARKET_FILTER_PARAM: ProtocolParamDef = {
  key: "filter",
  type: "string",
  enum: LIGHTER_MARKET_FILTERS,
  description:
    "Optional market-type filter accepted by Lighter: all, spot, or perp. The value is exact and unsupported values are rejected.",
};

const ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  description:
    "Optional Lighter account index as a safe non-negative integer. Provide exactly one of accountIndex or walletAddress.",
};

const AUTH_ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  description:
    "Optional account index. Omit to use the account embedded in the read-only token. Single-account tokens refuse mismatches.",
};

const REQUIRED_ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  required: true,
  description:
    "Required Lighter account index as a safe non-negative integer. This is public account-index metadata, not a private credential.",
};

const WALLET_ADDRESS_PARAM: ProtocolParamDef = {
  key: "walletAddress",
  type: "string",
  description:
    "Optional 0x-prefixed L1 EVM wallet address that owns the Lighter account. Provide exactly one of walletAddress or accountIndex.",
};

const ACTIVE_ONLY_PARAM: ProtocolParamDef = {
  key: "activeOnly",
  type: "boolean",
  description:
    "Optional Lighter account filter forwarded to the public account endpoint when supported.",
};

const MARKET_LIST_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max market rows to return after the provider response is read (default ${LIGHTER_AGENT_MARKET_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_MARKET_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const MARKET_LIST_PAGE_PARAM: ProtocolParamDef = {
  key: "page",
  type: "number",
  description:
    `1-based page over Vex's deterministic market ordering (default 1, max ${LIGHTER_AGENT_MARKET_PAGE_MAX}). Pair it with nextPage to continue broad lists.`,
};

const ORDERBOOK_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max ask rows and max bid rows to return (default ${LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX}). The response reports provider totals and truncation flags.`,
};

const ACCOUNT_ORDER_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max account order/trade rows to return (default ${LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_ACCOUNT_ORDER_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const API_KEY_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max API-key metadata rows to return (default ${LIGHTER_AGENT_API_KEY_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_API_KEY_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const API_KEY_INSPECT_INDEX_PARAM: ProtocolParamDef = {
  key: "apiKeyIndex",
  type: "number",
  description:
    "Optional Lighter API-key index from 0 to 255. Omit it to request the provider's all-keys sentinel, which is useful for nonce planning before a future signer path.",
};

const TRADES_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max recent trade rows to return (default ${LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX}). Out-of-range values are rejected, not clamped.`,
};

const ORDER_SIDE_PARAM: ProtocolParamDef = {
  key: "side",
  type: "string",
  required: true,
  enum: LIGHTER_ORDER_SIDES,
  description:
    "Order side to preview: buy or sell. If the user does not say which direction, ask a short clarification instead of guessing. Unsupported values are rejected.",
};

const BASE_AMOUNT_PARAM: ProtocolParamDef = {
  key: "baseAmountIn",
  type: "string",
  required: true,
  description:
    "Order size in the BASE asset as a human decimal string, for example 0.25. Vex converts it exactly using live Lighter size decimals and refuses rounding.",
};

const ORDER_PRICE_PARAM: ProtocolParamDef = {
  key: "price",
  type: "string",
  required: true,
  description:
    "Human price as a decimal string. For limit previews this is the limit price; for market previews it is the worst acceptable price. Vex converts it exactly using live Lighter price decimals.",
};

const ORDER_TYPE_PARAM: ProtocolParamDef = {
  key: "orderType",
  type: "string",
  enum: LIGHTER_ORDER_TYPES,
  description:
    "Optional order type supported by this preview gate: limit or market. Defaults to limit for normal price-at-size preview requests. Conditional and TWAP order previews are intentionally refused in this wave.",
};

const TIME_IN_FORCE_PARAM: ProtocolParamDef = {
  key: "timeInForce",
  type: "string",
  enum: LIGHTER_ORDER_TIME_IN_FORCE,
  description:
    "Optional Lighter time-in-force for the preview: good-till-time, immediate-or-cancel, or post-only. Defaults to good-till-time for normal limit previews. Market previews require immediate-or-cancel.",
};

const REDUCE_ONLY_PARAM: ProtocolParamDef = {
  key: "reduceOnly",
  type: "boolean",
  description:
    "Optional reduce-only flag. Defaults to false. When true, Vex requires live account position evidence that the side reduces the current position.",
};

const ORDER_EXPIRY_PARAM: ProtocolParamDef = {
  key: "orderExpiry",
  type: "number",
  description:
    "Exact order expiry as a JavaScript epoch-milliseconds integer. Use orderExpiryOffsetMinutes instead when the user says a relative expiry such as '30 minutes from now'. Vex requires the final expiry to be between 5 minutes and 30 days from preview time.",
};

const ORDER_EXPIRY_OFFSET_MINUTES_PARAM: ProtocolParamDef = {
  key: "orderExpiryOffsetMinutes",
  type: "number",
  description:
    `Preferred for relative expiries such as '30 minutes from now'. Whole minutes from preview time, between ${LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MIN} and ${LIGHTER_ORDER_EXPIRY_OFFSET_MINUTES_MAX}. Do not combine with orderExpiry.`,
};

const API_KEY_INDEX_PARAM: ProtocolParamDef = {
  key: "apiKeyIndex",
  type: "number",
  description:
    "Optional Lighter API-key index override. Omit for normal order previews; Vex attempts to resolve a public trading API-key index for later approval preparation, but a missing trading key does not block the read-only preview. This does not require or expose API private key material.",
};

const ONBOARDING_WALLET_ADDRESS_PARAM: ProtocolParamDef = {
  key: "walletAddress",
  type: "string",
  description:
    "Optional 0x-prefixed EVM wallet address to check. Omit to use the session's selected Vex wallet (resolved address-only). Never a private key.",
};

const ONBOARDING_REQUIRED_COLLATERAL_PARAM: ProtocolParamDef = {
  key: "amountIn",
  type: "string",
  description:
    "Optional intended position collateral in human settlement-asset decimals (USDC on Core or USDG on RHC, both 6 decimals), for example \"11\". Pass a known trade amount with marketSymbol or marketId so Vex checks the live market minimum before deposit preparation, then compares live Lighter collateral with the wallet's directly depositable settlement asset. Omit only during amount-free setup discovery. Never ask the user for account or API-key indexes.",
};

export const LIGHTER_READ_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "lighter.account.onboarding.status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Report the selected Vex wallet's complete managed Lighter readiness on Core or Robinhood Chain and the minimal setup steps still required. Omit walletAddress to use the selected wallet; never ask for account, API-key, nonce, fingerprint, or key material. Read-only: it checks the live market quote minimum, wallet-owned Lighter collateral, the environment-specific settlement asset (Ethereum USDC or Robinhood Chain USDG), native ETH gas balance, gateway allowance, live deposit minimum, and exact locally managed trading-credential readiness. Returns deterministic funding and trading-access routes. A sub-minimum trade/top-up or insufficient settlement balance stops before preparation. Eligible funding may route to lighter.deposit.prepare; once funding and account ownership are proven, missing managed access may route separately to lighter.key.register.prepare. This tool moves no funds and signs nothing.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      ONBOARDING_WALLET_ADDRESS_PARAM,
      ONBOARDING_REQUIRED_COLLATERAL_PARAM,
      MARKET_ID_OPTIONAL_PARAM,
      MARKET_SYMBOL_PARAM,
    ],
    atMostOne: [["marketId", "marketSymbol"]],
    exampleParams: { environment: "core", amountIn: "11", marketSymbol: "SUI" },
    discovery:
      LIGHTER_MARKET_DATA_DISCOVERY["lighter.account.onboarding.status"],
  },
  {
    toolId: "lighter.system",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read Lighter public system status and system configuration for Core or Robinhood Chain. Use when checking whether an environment is reachable, matching a market-data read to a network id, or reviewing public fee/cooldown configuration before deeper reads. Returns status code, network id, timestamp, pool indexes, cooldown periods, and public integrator fee ceilings. Read-only: no account lookup, credentials, wallet, signer, order, deposit, or withdrawal path.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM],
    exampleParams: { environment: "rhc" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.system"],
  },
  {
    toolId: "lighter.markets",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "List Lighter public markets/order books on Core or Robinhood Chain. Use when the user needs symbols, market ids, active/inactive status, spot versus perp coverage, fee strings, minimum order amounts, quote limits, or decimal metadata before requesting detail, depth, trades, or candles. Returns deterministically ordered, bounded market rows plus provider row count, page, nextPage, and truncation disclosure so broad market lists are walkable instead of silently shortened. Read-only: no account, key, signing, order, deposit, or withdrawal access.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, MARKET_LIST_LIMIT_PARAM, MARKET_LIST_PAGE_PARAM],
    exampleParams: { environment: "rhc", filter: "all", limit: 25, page: 1 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.markets"],
  },
  {
    toolId: "lighter.market.get",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Get detailed public metadata for one Lighter market on Core or Robinhood Chain by numeric marketId. Use when the user already has a market id and needs last trade price, daily activity, volume, open interest, fees, decimals, funding fields, minimums, and status before inspecting depth, trades, or candles. Returns matching detail rows and fails clearly if the market id is not found. Base and quote asset ids are numeric provider identifiers, not symbols; never infer labels for them from the market symbol. Read-only: no account data, signing, order placement, deposit, or withdrawal support.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_REQUIRED_PARAM, MARKET_FILTER_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, filter: "all" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.market.get"],
  },
  {
    toolId: "lighter.account.get",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read public Lighter account state on Core or Robinhood Chain by account index or the owning L1 walletAddress. Use when the user asks for public account balances, collateral, account status, assets, or account rows before deeper order/trade reads. Returns at most ${LIGHTER_AGENT_ACCOUNT_ROW_MAX} account rows and ${LIGHTER_AGENT_ACCOUNT_POSITION_MAX} inline positions/assets per account. Public read: no credential, wallet, signer, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, ACCOUNT_INDEX_PARAM, WALLET_ADDRESS_PARAM, ACTIVE_ONLY_PARAM],
    atMostOne: [["accountIndex", "walletAddress"]],
    atLeastOneOf: [["accountIndex", "walletAddress"]],
    exampleParams: { environment: "rhc", accountIndex: 42 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.account.get"],
  },
  {
    toolId: "lighter.positions",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read positions exposed through Lighter's public account endpoint on Core or Robinhood Chain by account index or the owning L1 walletAddress. Use when the user asks for public account positions, exposure, or holdings visible in Lighter account data. Returns bounded account rows and at most ${LIGHTER_AGENT_ACCOUNT_POSITION_MAX} positions per account. Public read: no credential, wallet, signer, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, ACCOUNT_INDEX_PARAM, WALLET_ADDRESS_PARAM, ACTIVE_ONLY_PARAM],
    atMostOne: [["accountIndex", "walletAddress"]],
    atLeastOneOf: [["accountIndex", "walletAddress"]],
    exampleParams: { environment: "rhc", accountIndex: 42 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.positions"],
  },
  {
    toolId: "lighter.openOrders",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read authenticated open Lighter orders for the account authorized by the configured Core or Robinhood Chain read-only token. Use when the user asks for their active/resting orders, open bids/asks, or order exposure. Defaults to the token's account when accountIndex is omitted; single-account tokens refuse mismatches. Returns exact provider string order identifiers for future safety. Read-only: no signing, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, AUTH_ACCOUNT_INDEX_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, ACCOUNT_ORDER_LIMIT_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.openOrders"],
  },
  {
    toolId: "lighter.orderHistory",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read authenticated inactive Lighter order history for the account authorized by the configured Core or Robinhood Chain read-only token. Use when the user asks for filled, cancelled, inactive, or historical orders. Defaults to the token's account when accountIndex is omitted; single-account tokens refuse mismatches. Returns exact provider string order identifiers. Read-only: no signing, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, AUTH_ACCOUNT_INDEX_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, ACCOUNT_ORDER_LIMIT_PARAM],
    exampleParams: { environment: "rhc", limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.orderHistory"],
  },
  {
    toolId: "lighter.trades",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read authenticated Lighter account trade history for the account authorized by the configured Core or Robinhood Chain read-only token. Use when the user asks for their fills, personal account trades, or executed trades rather than public market tape. Defaults to the token's account when accountIndex is omitted; single-account tokens refuse mismatches. Returns exact provider string trade and order ids. Read-only: no signing, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, AUTH_ACCOUNT_INDEX_PARAM, ACCOUNT_ORDER_LIMIT_PARAM],
    exampleParams: { environment: "rhc", limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.trades"],
  },
  {
    toolId: "lighter.apiKeys.inspect",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read public Lighter API-key metadata for an account on Core or Robinhood Chain. Use when checking which API-key slots exist on an account, their registered public keys, or current nonce values needed for nonce planning. Requires accountIndex and optionally apiKeyIndex. Returns bounded API-key rows with account index, api key index, public key, nonce, and transaction time. Public read: no credential, API private key, wallet, signer, auth-token minting, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, REQUIRED_ACCOUNT_INDEX_PARAM, API_KEY_INSPECT_INDEX_PARAM, API_KEY_LIMIT_PARAM],
    exampleParams: { environment: "rhc", accountIndex: 1, apiKeyIndex: 255, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.apiKeys.inspect"],
  },
  {
    toolId: "lighter.order.preview",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Create a live-data-backed Lighter order preview for a future exact matching order. Use this directly when the user says a conversational request like 'show me a preview limit buy order of 0.001 ETH at 3000, expires 30 minutes from now'. Prefer marketSymbol over marketId when the user names an asset. Omit environment, accountIndex, apiKeyIndex, timeInForce, and reduceOnly unless the user explicitly overrides them; Vex defaults or resolves those from configured/live Lighter state. If buy/sell is missing, ask for that direction in plain language. Returns previewId, the persisted preview identity, exact integer and display amounts, live market context, risk notes, and approvalReady. Inspect approvalReady: if true, say the next step is the Prepare trade approval button in the host UI and do not print internal tool names; if false, say the preview is read-only and a Lighter trading API key is needed before approval preparation. Do not ask to place, execute, submit, or broadcast from the preview result. Read-only: no signer, API private key, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      AUTH_ACCOUNT_INDEX_PARAM,
      API_KEY_INDEX_PARAM,
      MARKET_ID_OPTIONAL_PARAM,
      MARKET_SYMBOL_PARAM,
      ORDER_SIDE_PARAM,
      BASE_AMOUNT_PARAM,
      ORDER_PRICE_PARAM,
      ORDER_TYPE_PARAM,
      TIME_IN_FORCE_PARAM,
      REDUCE_ONLY_PARAM,
      ORDER_EXPIRY_PARAM,
      ORDER_EXPIRY_OFFSET_MINUTES_PARAM,
    ],
    atMostOne: [["marketId", "marketSymbol"], ["orderExpiry", "orderExpiryOffsetMinutes"]],
    atLeastOneOf: [["marketId", "marketSymbol"], ["orderExpiry", "orderExpiryOffsetMinutes"]],
    exampleParams: {
      marketSymbol: "ETH",
      side: "buy",
      baseAmountIn: "0.001",
      price: "3000",
      orderType: "limit",
      orderExpiryOffsetMinutes: 30,
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.preview"],
  },
  {
    toolId: "lighter.deposit.status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Check and reconcile the durable state of this Vex wallet's Lighter deposit intents. Use after an approval, a pending or ambiguous Ethereum outcome, or when a second deposit is refused because an earlier intent is unresolved. Repair reads only already-staged Ethereum transaction identities, accepts only provider-proven same-calldata fee repricings within the original approval ceiling, rechecks canonical Ethereum receipts, and requires exact Lighter credit plus wallet ownership evidence; it never infers credit from generic account existence. Returns approval and execution state, original and replacement transaction identities, exact L1/Lighter evidence, repair reports, and explicit next-action guidance. An optional intent id checks one local intent; omitting it checks this wallet's unresolved deposit intents. This tool never signs, broadcasts, retries, or creates a replacement transaction and moves no funds.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      {
        key: "intentId",
        type: "string",
        description:
          "Optional Lighter deposit intent id returned by lighter.deposit.prepare. Omit to list every unresolved deposit intent for the selected Vex wallet and environment.",
      },
    ],
    exampleParams: { environment: "core" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.deposit.status"],
  },
  {
    toolId: "lighter.withdraw.status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Reconcile one durable Lighter Core secure USDC withdrawal from exact evidence. Reads the submitted TxType 13 transaction, authenticated paginated withdrawal history, current Ethereum gateway pending balance, and—when Lighter supplies an L1 hash—the canonical receipt and block. It adopts only one exact amount/time/history identity and marks final delivery only after one matching Core WithdrawPending event, one exact gateway-to-owner USDC transfer, canonical block membership, zero pending balance, and 12 confirmations. Missing, contradictory, or ambiguous evidence never triggers a retry. Omit intentId to check the latest withdrawal in this session.",
    mutating: false,
    actionKind: "read",
    params: [{
      key: "intentId",
      type: "string",
      description: "Optional session-scoped Core withdrawal intent id from lighter.withdraw.prepare or lighter.withdraw.",
    }],
    exampleParams: {},
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.withdraw.status"],
  },
  {
    toolId: "lighter.key.register.status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Check and reconcile one already-staged Lighter Core or Robinhood Chain key registration from exact provider and local vault evidence. Use after the approved registration returns submitted_pending_verification, ambiguity_unresolved, registered_key_conflict, or key_verified_pending_nonce. It reads the exact environment-specific public API-key slot, verifies that it equals the vault-derived public key, runs the official CheckClient equivalent against that environment, and requires the next nonce to equal the approved nonce plus one before promoting the local encrypted credential to active. This evidence-only path structurally refuses intents that have not staged a TxType 8 transaction and never signs, calls sendTx, retries, deposits, trades, transfers, or withdraws.",
    mutating: false,
    actionKind: "read",
    params: [{
      key: "intentId",
      type: "string",
      required: true,
      description:
        "Session-scoped Lighter key-registration intent id returned by lighter.key.register.prepare or the approved registration result.",
    }],
    exampleParams: { intentId: "lighter-onboard-example" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.key.register.status"],
  },
  {
    toolId: "lighter.order.status",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Check and reconcile the true state of Vex-submitted Lighter orders. Use when the user asks what happened to a Lighter order, an order create ended sequencer_pending or ambiguous, or a new order was refused because a nonce reservation is unresolved. Reads live nextNonce and, when a read-only token is configured, account orders and trades, then updates local order records from that evidence only: it can classify an order as open, filled, canceled, or rejected, and it releases a stuck nonce reservation only when the reserved nonce is provably spent, the signed transaction never left Vex, or the order expired unconsumed. Returns per-intent reports with state before/after, evidence source, nonce blockage, and explicit wait-or-resolved guidance. It never signs, submits, retries, or cancels an order and moves no funds.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      {
        key: "intentId",
        type: "string",
        description:
          "Optional Lighter order execution intent id to check, from lighter.order.create.prepare or an earlier status report. Omit to check every unresolved local Lighter order intent for the environment.",
      },
    ],
    exampleParams: { environment: "rhc" },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.status"],
  },
  {
    toolId: "lighter.orderbook",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read public resting order book orders for one Lighter market on Core or Robinhood Chain. Use when the user asks for current bids, asks, spread context, or visible liquidity around a known market id before making a market decision. Returns bounded ask and bid rows with order id, owner account index, price, initial size, remaining size, raw epoch-millisecond expiry, ISO expiry, provider totals, and truncation flags. Prefer the ISO expiry for user-facing output. Read-only: this does not place, cancel, sign, fill, deposit, or withdraw.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_REQUIRED_PARAM, ORDERBOOK_LIMIT_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.orderbook"],
  },
  {
    toolId: "lighter.recentTrades",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read the recent public trade tape for one Lighter market on Core or Robinhood Chain. Use when the user asks for latest fills, trade prices, sizes, maker side, USD amount, block height, transaction hash, or short-term activity before comparing with depth or candles. Returns bounded trade rows plus provider row count, truncation state, and next cursor when Lighter supplies one. Read-only: no private account data, signing, order placement, deposit, or withdrawal support.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_REQUIRED_PARAM, TRADES_LIMIT_PARAM],
    exampleParams: { environment: "rhc", marketId: 0, limit: 25 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.recentTrades"],
  },
  {
    toolId: "lighter.candles",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read public OHLCV candles for one Lighter market on Core or Robinhood Chain using epoch-millisecond start/end timestamps. Use when the user asks for chart history, recent price movement, volatility, or candle data after choosing a market id. Returns the newest candle rows up to the agent output cap, plus provider row count, requested window, resolution, countBack, and truncation disclosure. Read-only: no account lookup, signing, order, deposit, or withdrawal path.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      MARKET_ID_REQUIRED_PARAM,
      {
        key: "resolution",
        type: "string",
        required: true,
        enum: LIGHTER_CANDLE_RESOLUTIONS,
        description:
          "Candle bucket size accepted by Lighter: 1m, 5m, 15m, 30m, 1h, 4h, 12h, 1d, or 1w. Unsupported values are rejected.",
      },
      {
        key: "startTimestamp",
        type: "number",
        required: true,
        description:
          "Window start as a JavaScript epoch-milliseconds integer. Seconds-scale Unix timestamps are rejected before any provider request.",
      },
      {
        key: "endTimestamp",
        type: "number",
        required: true,
        description:
          "Window end as a JavaScript epoch-milliseconds integer. It must be greater than startTimestamp or the call is rejected.",
      },
      {
        key: "countBack",
        type: "number",
        description:
          "Provider candle row cap for the requested range (max 500). Vex also shows at most "
          + `${LIGHTER_AGENT_CANDLE_OUTPUT_MAX} newest rows in the agent response.`,
      },
      {
        key: "setTimestampToEnd",
        type: "boolean",
        description:
          "Optional Lighter candle flag controlling whether returned timestamps point at the candle end instead of its start.",
      },
    ],
    exampleParams: {
      environment: "rhc",
      marketId: 0,
      resolution: "1h",
      startTimestamp: 1786147200000,
      endTimestamp: 1786233600000,
      countBack: 24,
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.candles"],
  },
];
