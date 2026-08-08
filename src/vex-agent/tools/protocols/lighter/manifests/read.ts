import {
  LIGHTER_CANDLE_RESOLUTIONS,
  LIGHTER_ENVIRONMENTS,
  LIGHTER_MARKET_FILTERS,
} from "@tools/lighter/constants.js";
import type { ProtocolParamDef, ProtocolToolManifest } from "../../types.js";
import { LIGHTER_MARKET_DATA_DISCOVERY } from "../../embeddings/lighter/market-data.js";
import {
  LIGHTER_AGENT_CANDLE_OUTPUT_MAX,
  LIGHTER_AGENT_MARKET_LIMIT_DEFAULT,
  LIGHTER_AGENT_MARKET_LIMIT_MAX,
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

const MARKET_LIST_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max market rows to return after the provider response is read (default ${LIGHTER_AGENT_MARKET_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_MARKET_LIMIT_MAX}). Out-of-range values are rejected.`,
};

const ORDERBOOK_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max ask rows and max bid rows to return (default ${LIGHTER_AGENT_ORDERBOOK_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_ORDERBOOK_LIMIT_MAX}). The response reports provider totals and truncation flags.`,
};

const TRADES_LIMIT_PARAM: ProtocolParamDef = {
  key: "limit",
  type: "number",
  description:
    `Max recent trade rows to return (default ${LIGHTER_AGENT_RECENT_TRADES_LIMIT_DEFAULT}, max ${LIGHTER_AGENT_RECENT_TRADES_LIMIT_MAX}). Out-of-range values are rejected, not clamped.`,
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
      "List Lighter public markets/order books on Core or Robinhood Chain. Use when the user needs symbols, market ids, active/inactive status, spot versus perp coverage, fee strings, minimum order amounts, quote limits, or decimal metadata before requesting detail, depth, trades, or candles. Returns bounded market rows plus provider row count and a truncation flag so broad market lists are never silently shortened. Read-only: no account, key, signing, order, deposit, or withdrawal access.",
    mutating: false,
    actionKind: "read",
    params: [ENVIRONMENT_PARAM, MARKET_ID_OPTIONAL_PARAM, MARKET_FILTER_PARAM, MARKET_LIST_LIMIT_PARAM],
    exampleParams: { environment: "rhc", filter: "all", limit: 25 },
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
