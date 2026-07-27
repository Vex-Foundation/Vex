/**
 * Pendle protocol manifest — fixed-yield PT + variable YT + PY mint/redeem + LP
 * single-token add/remove across 11 chains.
 *
 * Read: market screening and position valuation, plus the market-data surface —
 * one market's detail and accepted tokens, its APY/TVL history and price
 * candles, its limit-order depth, the wallet's merkle reward accruals, and asset
 * price marks. Every one of those is read-only and none of them signs anything.
 *
 * Mutating: PT quote (records the prequote), buy, early-exit sell, and matured
 * redeem; YT quote, buy, and early-exit sell; PY quote, mint (token → PT+YT), and
 * pre-expiry redeem (PT+YT → token); LP quote, single-token add (token → LP) and
 * remove (LP → token); and a claim income-sweep. Every mutating path is
 * approval-gated with provider "pendle" and pins the canonical Pendle Router
 * (PT/YT/PY/LP trades are also prequote-gated; the claim income-sweep has no
 * quote).
 */

import type { ProtocolToolManifest } from "../types.js";
import { PENDLE_READ_TOOLS } from "./manifests/read.js";
import { PENDLE_MARKET_GET_TOOL } from "./manifests/market-get.js";
import { PENDLE_MARKET_HISTORY_TOOL } from "./manifests/market-history.js";
import { PENDLE_MARKET_CANDLES_TOOL } from "./manifests/market-candles.js";
import { PENDLE_ORDERBOOK_TOOL } from "./manifests/orderbook.js";
import { PENDLE_REWARDS_MERKLE_TOOL } from "./manifests/rewards-merkle.js";
import { PENDLE_PRICES_ASSETS_TOOL } from "./manifests/prices-assets.js";
import { PENDLE_PT_TOOLS } from "./manifests/pt.js";
import { PENDLE_YT_TOOLS } from "./manifests/yt.js";
import { PENDLE_PY_TOOLS } from "./manifests/py.js";
import { PENDLE_LP_TOOLS } from "./manifests/lp.js";

/** The six market-data reads, each owning its own contract module. */
const PENDLE_MARKET_READ_TOOLS: readonly ProtocolToolManifest[] = [
  PENDLE_MARKET_GET_TOOL,
  PENDLE_MARKET_HISTORY_TOOL,
  PENDLE_MARKET_CANDLES_TOOL,
  PENDLE_ORDERBOOK_TOOL,
  PENDLE_REWARDS_MERKLE_TOOL,
  PENDLE_PRICES_ASSETS_TOOL,
];

export const PENDLE_TOOLS: readonly ProtocolToolManifest[] = [
  ...PENDLE_READ_TOOLS,
  ...PENDLE_MARKET_READ_TOOLS,
  ...PENDLE_PT_TOOLS,
  ...PENDLE_YT_TOOLS,
  ...PENDLE_PY_TOOLS,
  ...PENDLE_LP_TOOLS,
];
