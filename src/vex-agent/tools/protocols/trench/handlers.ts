/**
 * Trench Express handlers.
 *
 * Read tools (`tokens`, `search`, `trades`) call the launchpad REST client;
 * `launch_preview` runs an on-chain dry-run of `create()` (no signature). The
 * money-path tools `trade_quote` (read) and `trade_execute` (curve buy/sell,
 * staged broadcast) drive the deterministic RBC bonding curve.
 */

import type { ProtocolHandler } from "../types.js";
import { trenchTokensHandler } from "./handlers/list.js";
import { trenchSearchHandler } from "./handlers/search.js";
import { trenchTradesHandler } from "./handlers/trades.js";
import { trenchLaunchPreviewHandler } from "./handlers/launch-preview.js";
import { trenchTradeQuoteHandler } from "./handlers/trade-quote.js";
import { trenchTradeExecuteHandler } from "./handlers/trade-execute.js";
// NOTE (2026-08-02): trench deliberately has NO per-protocol settlement decoder.
// The owner decree of 2026-07-30 retired per-protocol settlement verification —
// `sync/settlement-decoders.ts` was deleted and pending rows are now resolved by
// the STATUS-ONLY repair sweep (`sync/agent-activity-repair.ts`), which asks one
// chain-status question per row and explicitly sources Robinhood Chain (4663)
// from the local evm-chains registry. An ambiguous trench row IS repairable
// today; a repaired row keeps `executed_*` NULL and Agent Scan labels the quoted
// amount "estimated". Do not reintroduce a decoder here.

export const TRENCH_HANDLERS: Record<string, ProtocolHandler> = {
  "trench.tokens": (p) => trenchTokensHandler(p),
  "trench.search": (p) => trenchSearchHandler(p),
  "trench.trades": (p) => trenchTradesHandler(p),
  "trench.launch_preview": (p, context) => trenchLaunchPreviewHandler(p, context),
  "trench.trade_quote": (p, context) => trenchTradeQuoteHandler(p, context),
  "trench.trade_execute": (p, context) => trenchTradeExecuteHandler(p, context),
};
