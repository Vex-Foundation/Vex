import type { ProtocolToolManifest } from "../../types.js";
import { POOLS_CANDLES_DISCOVERY } from "../../embeddings/pools/candles.js";
import {
  POOLS_CANDLE_AGGREGATE_CAP,
  POOLS_CANDLE_LIMIT_CAP,
  POOLS_CANDLE_TIMEFRAMES,
} from "@tools/pools-fun/constants.js";

// Price history for ONE pools.fun token - READ-ONLY. The wire sends positional
// arrays; the handler projects them into named candle objects, because open and
// close are one array slot apart and nothing in the data would reveal a swap.

export const POOLS_CANDLES_TOOLS: readonly ProtocolToolManifest[] = [
  {
    toolId: "pools.candles",
    namespace: "pools",
    lifecycle: "active",
    description:
      "Read the price history of ONE pools.fun token on Robinhood Chain (4663) as OHLCV candles. Use this after resolving a token to analyse how it has traded: pick the candle span with timeframe and aggregate (minute with aggregate 15 gives quarter-hour candles, hour with aggregate 4 gives four-hour candles) and how many candles with limit. Returns the token and its pool, the trading pair with the quote asset named, the candle span, a count, the order the candles are in, and the candles themselves as objects with time, open, high, low, close and volumeUsd. Prices are quoted in the pool's quote asset - WETH, USDG or a tokenised stock, named in the reply - and are display-grade; volume is in US dollars. The candle order is reported from the data rather than assumed, so read the order field instead of guessing which end is newest. An address the launchpad has no pool for is reported as a named not-found, not an empty chart. For liquidity or fully-diluted-value cross-checks use dexscreener. Read-only.",
    mutating: false,
    actionKind: "read",
    params: [
      {
        key: "tokenAddress",
        type: "string",
        required: true,
        description:
          "Contract address of the pools.fun token whose price history to read. Resolve it with pools.search first - a symbol is not an identity on this launchpad.",
      },
      {
        key: "timeframe",
        type: "string",
        enum: [...POOLS_CANDLE_TIMEFRAMES],
        description:
          "Base unit of one candle: minute, hour (default) or day. The real candle span is this multiplied by aggregate.",
      },
      {
        key: "aggregate",
        type: "number",
        description:
          `How many timeframe units make one candle, 1-${POOLS_CANDLE_AGGREGATE_CAP} (default 1). Combine with timeframe: minute plus 15 is a quarter-hour candle, hour plus 4 is a four-hour candle.`,
      },
      {
        key: "limit",
        type: "number",
        description:
          `How many candles to return, 1-${POOLS_CANDLE_LIMIT_CAP} (default 30). Ask for the window the analysis needs rather than the maximum.`,
      },
    ],
    exampleParams: { tokenAddress: "0x0ab8d01664d4bb625705f9f3c595a8a19b3dcfb0", timeframe: "hour", limit: 24 },
    discovery: POOLS_CANDLES_DISCOVERY["pools.candles"],
  },
];
