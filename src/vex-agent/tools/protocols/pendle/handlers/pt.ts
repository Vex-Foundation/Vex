/**
 * Pendle PT handlers — quote (read) + buy / sell / redeem (mutating).
 *
 * This file is the PT family's PUBLIC ENTRY POINT; each tool's implementation
 * lives in `./pt/`.
 *
 * Quote hits Convert to preview a route and records the prequote (swap for a
 * buy/early-exit sell, redeem for a matured PT). Every mutating path RE-FETCHES
 * Convert, then runs the fund-safety extractor (`../calldata.ts`, LOCKED G2#1)
 * before signing: Router pin, sender/value bind, EXACT approval-set bind, and
 * calldata intent bind (selector + decoded receiver == wallet + market/YT ==
 * quoted). Nothing is signed unless every check passes. Redeem has an
 * API-independent `redeemPyToSy` fallback for a matured position when Convert is
 * unavailable.
 *
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import type { ProtocolHandler } from "../../types.js";

import { pendlePtQuote } from "./pt/quote.js";
import { executePendleSwap } from "./pt/swap.js";
import { executePendleRedeem } from "./pt/redeem.js";

export const PENDLE_PT_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.pt.quote": (p, ctx) => pendlePtQuote(p, ctx),
  "pendle.pt.buy": (p, ctx) => executePendleSwap(p, "buy", ctx),
  "pendle.pt.sell": (p, ctx) => executePendleSwap(p, "sell", ctx),
  "pendle.pt.redeem": (p, ctx) => executePendleRedeem(p, ctx),
};
