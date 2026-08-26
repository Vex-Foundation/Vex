/**
 * Handlers for the site DEEP-DIVE family: pair details, candles, trades and
 * top traders.
 *
 * One module per tool under `deep-dive/`, because each one reads a different
 * channel with a different codec and a different set of things it must not
 * claim; they share only the subject resolution and the shaping vocabulary in
 * `deep-dive/_shared.ts`. `DEXSCREENER_DEEP_DIVE_HANDLERS` is the single public
 * surface and the split is invisible to `protocols/runtime.ts`.
 */

import type { ProtocolHandler } from "../../types.js";
import { guarded } from "./deep-dive/_shared.js";
import { runCandles } from "./deep-dive/candles.js";
import { runPairDetails } from "./deep-dive/pair-details.js";
import { runTopTraders } from "./deep-dive/top-traders.js";
import { runTrades } from "./deep-dive/trades.js";

export const DEXSCREENER_DEEP_DIVE_HANDLERS: Record<string, ProtocolHandler> = {
  "dexscreener.pair.details": guarded("dexscreener__pair_details_get", (p, s) =>
    runPairDetails(p, s)
  ),
  "dexscreener.candles": guarded("dexscreener__candles_list", (p, s) =>
    runCandles(p, s)
  ),
  "dexscreener.trades": guarded("dexscreener__trades_list", (p, s) =>
    runTrades(p, s)
  ),
  "dexscreener.top.traders": guarded("dexscreener__top_traders_list", (p, s) =>
    runTopTraders(p, s)
  ),
};
