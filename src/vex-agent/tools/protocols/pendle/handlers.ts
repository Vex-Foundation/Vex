/**
 * Pendle protocol handlers — aggregates the portfolio reads, the market-data
 * reads, and the PT / YT / PY / LP trade modules.
 *
 * The two read maps are separate because they answer different questions and
 * carry different dependencies: `read.ts` covers the wallet-shaped reads
 * (screening and portfolio), `market-reads.ts` the per-market and per-asset ones
 * and the asset-decimals lookup they need.
 */

import type { ProtocolHandler } from "../types.js";
import { PENDLE_READ_HANDLERS } from "./handlers/read.js";
import { PENDLE_MARKET_READ_HANDLERS } from "./handlers/market-reads.js";
import { PENDLE_PT_HANDLERS } from "./handlers/pt.js";
import { PENDLE_YT_HANDLERS } from "./handlers/yt.js";
import { PENDLE_PY_HANDLERS } from "./handlers/py.js";
import { PENDLE_LP_HANDLERS } from "./handlers/lp.js";

export const PENDLE_HANDLERS: Record<string, ProtocolHandler> = {
  ...PENDLE_READ_HANDLERS,
  ...PENDLE_MARKET_READ_HANDLERS,
  ...PENDLE_PT_HANDLERS,
  ...PENDLE_YT_HANDLERS,
  ...PENDLE_PY_HANDLERS,
  ...PENDLE_LP_HANDLERS,
};
