import {
  LIGHTER_CANDLE_RESOLUTIONS,
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
  LIGHTER_AGENT_ACCOUNT_ROW_MAX,
  LIGHTER_AGENT_MARKET_LIMIT_DEFAULT,
  LIGHTER_AGENT_MARKET_LIMIT_MAX,
  LIGHTER_AGENT_MARKET_PAGE_MAX,
  LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT,
  LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX,
  LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT,
  LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX,
} from "../params.js";

const ENVIRONMENT_PARAM: ProtocolParamDef = {
  key: "environment",
  type: "string",
  required: true,
  enum: LIGHTER_ENVIRONMENTS,
  description:
    "REQUIRED. Public Lighter environment to read: core for Lighter Core, rhc for Robinhood Chain. Any other value is rejected.",
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
    "Optional Lighter account index as a safe non-negative integer. Provide exactly one of accountIndex or l1Address.",
};

const AUTH_ACCOUNT_INDEX_PARAM: ProtocolParamDef = {
  key: "accountIndex",
  type: "number",
  description:
    "Optional account index. Omit to use the account embedded in the read-only token. Single-account tokens refuse mismatches.",
};

const L1_ADDRESS_PARAM: ProtocolParamDef = {
  key: "l1Address",
  type: "string",
  description:
    "Optional 0x-prefixed L1 EVM wallet address. Provide exactly one of l1Address or accountIndex.",
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
    "Order side to preview: buy for bid/long-increasing orders, sell for ask/long-reducing orders. Unsupported values are rejected.",
};

const BASE_AMOUNT_PARAM: ProtocolParamDef = {
  key: "baseAmount",
  type: "string",
  required: true,
  description:
    "Human base amount as a decimal string, for example 0.25. Vex converts it exactly using live Lighter size decimals and refuses rounding.",
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
  required: true,
  enum: LIGHTER_ORDER_TYPES,
  description:
    "Order type supported by this preview gate: limit or market. Conditional and TWAP order previews are intentionally refused in this wave.",
};

const TIME_IN_FORCE_PARAM: ProtocolParamDef = {
  key: "timeInForce",
  type: "string",
  required: true,
  enum: LIGHTER_ORDER_TIME_IN_FORCE,
  description:
    "Lighter time-in-force for the preview: good-till-time, immediate-or-cancel, or post-only. Market previews require immediate-or-cancel.",
};

const REDUCE_ONLY_PARAM: ProtocolParamDef = {
  key: "reduceOnly",
  type: "boolean",
  required: true,
  description:
    "Whether the preview is reduce-only. When true, Vex requires live account position evidence that the side reduces the current position.",
};

const ORDER_EXPIRY_PARAM: ProtocolParamDef = {
  key: "orderExpiry",
  type: "number",
  required: true,
  description:
    "Order expiry as a JavaScript epoch-milliseconds integer. Vex requires it to be between 5 minutes and 30 days from preview time.",
};

const API_KEY_INDEX_PARAM: ProtocolParamDef = {
  key: "apiKeyIndex",
  type: "number",
  description:
    "Optional Lighter API-key index to bind into the preview identity. This does not require or expose API private key material.",
};

const CLIENT_ORDER_INDEX_POLICY_PARAM: ProtocolParamDef = {
  key: "clientOrderIndexPolicy",
  type: "string",
  required: true,
  description:
    "Client order index policy string to bind into the preview identity, for example vex_assigned_uint48. A later create path must match it exactly.",
};

export const LIGHTER_READ_TOOLS: readonly ProtocolToolManifest[] = [
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
      "Get detailed public metadata for one Lighter market on Core or Robinhood Chain by numeric marketId. Use when the user already has a market id and needs last trade price, daily activity, volume, open interest, fees, decimals, funding fields, minimums, and status before inspecting depth, trades, or candles. Returns matching detail rows and fails clearly if the market id is not found. Read-only: no account data, signing, order placement, deposit, or withdrawal support.",
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
      `Read public Lighter account state on Core or Robinhood Chain by account index or L1 address. Use when the user asks for public account balances, collateral, account status, assets, or account rows before deeper order/trade reads. Returns at most ${LIGHTER_AGENT_ACCOUNT_ROW_MAX} account rows and ${LIGHTER_AGENT_ACCOUNT_POSITION_MAX} inline positions/assets per account. Public read: no credential, wallet, signer, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, ACCOUNT_INDEX_PARAM, L1_ADDRESS_PARAM, ACTIVE_ONLY_PARAM],
    exampleParams: { environment: "rhc", accountIndex: 42 },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.account.get"],
  },
  {
    toolId: "lighter.positions",
    namespace: "lighter",
    lifecycle: "active",
    description:
      `Read positions exposed through Lighter's public account endpoint on Core or Robinhood Chain by account index or L1 address. Use when the user asks for public account positions, exposure, or holdings visible in Lighter account data. Returns bounded account rows and at most ${LIGHTER_AGENT_ACCOUNT_POSITION_MAX} positions per account. Public read: no credential, wallet, signer, order placement, cancellation, deposit, or withdrawal support.`,
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, ACCOUNT_INDEX_PARAM, L1_ADDRESS_PARAM, ACTIVE_ONLY_PARAM],
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
    toolId: "lighter.order.preview",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Create a live-data-backed Lighter order preview on Core or Robinhood Chain for a future exact matching order. Reads live market detail, order book top-of-book context, and public account position data, converts display amount/price into exact integer fields, stores a session-scoped preview identity, and returns the preview id/hash. Read-only: no signer, API private key, signature, sendTx, order placement, cancellation, deposit, withdrawal, or transfer path.",
    mutating: false,
    actionKind: "read",
    params: [
      ENVIRONMENT_PARAM,
      AUTH_ACCOUNT_INDEX_PARAM,
      API_KEY_INDEX_PARAM,
      MARKET_ID_REQUIRED_PARAM,
      ORDER_SIDE_PARAM,
      BASE_AMOUNT_PARAM,
      ORDER_PRICE_PARAM,
      ORDER_TYPE_PARAM,
      TIME_IN_FORCE_PARAM,
      REDUCE_ONLY_PARAM,
      ORDER_EXPIRY_PARAM,
      CLIENT_ORDER_INDEX_POLICY_PARAM,
    ],
    exampleParams: {
      environment: "rhc",
      accountIndex: 42,
      marketId: 0,
      side: "buy",
      baseAmount: "0.25",
      price: "3000",
      orderType: "limit",
      timeInForce: "good-till-time",
      reduceOnly: false,
      orderExpiry: 1786233600000,
      clientOrderIndexPolicy: "vex_assigned_uint48",
    },
    discovery: LIGHTER_MARKET_DATA_DISCOVERY["lighter.order.preview"],
  },
  {
    toolId: "lighter.orderbook",
    namespace: "lighter",
    lifecycle: "active",
    description:
      "Read public resting order book orders for one Lighter market on Core or Robinhood Chain. Use when the user asks for current bids, asks, spread context, or visible liquidity around a known market id before making a market decision. Returns bounded ask and bid rows with order id, owner account index, price, initial size, remaining size, expiry, provider totals, and truncation flags. Read-only: this does not place, cancel, sign, fill, deposit, or withdraw.",
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
