/**
 * DexScreener protocol handlers - aggregates the four family handler maps.
 *
 * All read-only: no wallet, no signing, no mutations. Split by family so each
 * handler sits next to the channel and the projection it uses:
 *
 * | module                       | tools                                                                                                  | channel                        |
 * |------------------------------|--------------------------------------------------------------------------------------------------------|--------------------------------|
 * | `handlers/screening.ts`      | pairs.trending, pairs.top, gainers, losers, pairs.new, launchpad.pairs, chains, tokens.screen             | screener WS + catalog          |
 * | `handlers/resolve.ts`        | pair.get, spotlight, pairs.batch, search, tokenPairs                                                     | pair WS, spotlight, search v12 |
 * | `handlers/market-context.ts` | trending (narratives)                                                                                    | metas Avro                     |
 * | `handlers/deep-dive.ts`      | pair.details, candles, trades, top.traders                                                               | pair-details JSON, chart Avro and feed WS, Connect RPC, top-makers Avro |
 *
 * `DEXSCREENER_HANDLERS` remains the single public surface; the split is
 * invisible to `protocols/runtime.ts` and to every test.
 */

import type { ProtocolHandler } from "../types.js";
import { DEXSCREENER_MARKET_CONTEXT_HANDLERS } from "./handlers/market-context.js";
import { DEXSCREENER_RESOLVE_HANDLERS } from "./handlers/resolve.js";
import { DEXSCREENER_SCREENING_HANDLERS } from "./handlers/screening.js";
import { DEXSCREENER_DEEP_DIVE_HANDLERS } from "./handlers/deep-dive.js";

export const DEXSCREENER_HANDLERS: Record<string, ProtocolHandler> = {
  ...DEXSCREENER_SCREENING_HANDLERS,
  ...DEXSCREENER_RESOLVE_HANDLERS,
  ...DEXSCREENER_MARKET_CONTEXT_HANDLERS,
  ...DEXSCREENER_DEEP_DIVE_HANDLERS,
};
