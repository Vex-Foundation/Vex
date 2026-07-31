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
// Side-effect: register the Trench settlement decoder so the agent_activity
// repair sweep can finalize ambiguous/undecodable curve rows without a signer.
import "./settlement-decoder.js";

export const TRENCH_HANDLERS: Record<string, ProtocolHandler> = {
  "trench.tokens": (p) => trenchTokensHandler(p),
  "trench.search": (p) => trenchSearchHandler(p),
  "trench.trades": (p) => trenchTradesHandler(p),
  "trench.launch_preview": (p, context) => trenchLaunchPreviewHandler(p, context),
  "trench.trade_quote": (p, context) => trenchTradeQuoteHandler(p, context),
  "trench.trade_execute": (p, context) => trenchTradeExecuteHandler(p, context),
};
