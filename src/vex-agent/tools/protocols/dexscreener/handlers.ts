/**
 * DexScreener protocol handlers — aggregates the four family handler maps.
 *
 * All read-only: no wallet, no signing, no mutations. Split by family so the
 * three list pipelines each sit next to the handlers that use them:
 *
 * | module                 | tools                                                    | pipeline              |
 * |------------------------|----------------------------------------------------------|-----------------------|
 * | `handlers/core.ts`     | search, pairs, tokens, tokenPairs                        | `pair-list/`          |
 * | `handlers/feeds.ts`    | profiles, profiles.recent, boosts, boosts.top, communityTakeovers, ads, attention | `feed-list/` |
 * | `handlers/narratives.ts` | trending, meta                                         | `narrative-list/`     |
 * | `handlers/orders.ts`   | orders                                                   | none — per-token      |
 *
 * `DEXSCREENER_HANDLERS` remains the single public surface; the split is
 * invisible to `protocols/runtime.ts` and to every test.
 */

import type { ProtocolHandler } from "../types.js";
import { DEXSCREENER_CORE_HANDLERS } from "./handlers/core.js";
import { DEXSCREENER_FEED_HANDLERS } from "./handlers/feeds.js";
import { DEXSCREENER_NARRATIVE_HANDLERS } from "./handlers/narratives.js";
import { DEXSCREENER_ORDER_HANDLERS } from "./handlers/orders.js";

export const DEXSCREENER_HANDLERS: Record<string, ProtocolHandler> = {
  ...DEXSCREENER_CORE_HANDLERS,
  ...DEXSCREENER_FEED_HANDLERS,
  ...DEXSCREENER_NARRATIVE_HANDLERS,
  ...DEXSCREENER_ORDER_HANDLERS,
};
