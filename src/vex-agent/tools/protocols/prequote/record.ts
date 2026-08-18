/**
 * Swap/bridge prequote recording (Stage 6c / 8c).
 *
 * RECORDER — for a SUCCESSFUL swap QUOTE this module computes:
 *   1. a deterministic match-hash over the trade identity (reused verbatim by
 *      the Stage-7 execute gate so record-time and gate-time hashes collide),
 *   2. a 3-state token-safety verdict (`pass` | `fail` | `unknown`),
 *   3. a bounded, structural-only `safetyDetail` payload,
 * then records a `swap_prequotes` row. Recording is best-effort: any failure is
 * swallowed (logged structurally) so it never alters the quote's ToolResult. A
 * missing prequote is safe — the Stage-7 gate blocks the execute instead.
 *
 * NEVER persist or log raw provider/HTTP/DB/error text — only bounded structural
 * labels.
 *
 * This file is the public entry point and dispatches by the registered `kind`;
 * each kind's recorder lives in the same-named sibling folder: `record/swap.ts`,
 * `record/bridge.ts`, `record/pendle-pt.ts`, `record/pendle-py.ts`,
 * `record/pendle-lp.ts`, with the shared row materialization in `record/row.ts`.
 */

import logger from "@utils/logger.js";

import type { ProtocolExecutionContext } from "../types.js";

import { PREQUOTE_QUOTE_TOOLS } from "./registry.js";
import { recordBridgePrequote } from "./record/bridge.js";
import { recordMorphoBorrowPrequote } from "./record/morpho-borrow.js";
import { recordMorphoLendPrequote } from "./record/morpho-lend.js";
import { recordPendleLpPrequote } from "./record/pendle-lp.js";
import { recordPendlePrequote } from "./record/pendle-pt.js";
import { recordPendlePyPrequote } from "./record/pendle-py.js";
import { recordSwapPrequote } from "./record/swap.js";

/**
 * Record a prequote from a successful quote. Best-effort: resolves the would-be
 * signing address (skips on a wallet-scope throw — never fabricates an address),
 * validates + extracts the quote, computes the match-hash + verdict, and writes
 * the row. Never throws to the caller; structural logs only. Dispatches by the
 * registered `kind`: a `swap` quote records a token-safety verdict; a `bridge`
 * quote always records verdict `unknown` (a Khalani route proves availability,
 * NOT token safety — Codex requirement #3).
 */
export async function recordPrequoteFromQuote(
  toolId: string,
  params: Record<string, unknown>,
  resultData: Record<string, unknown>,
  context: ProtocolExecutionContext,
): Promise<void> {
  const registered = PREQUOTE_QUOTE_TOOLS[toolId];
  if (!registered) return;

  const sessionId = context.sessionId;
  if (!sessionId) {
    logger.warn("protocol.prequote.skipped", { toolId, reason: "no_session" });
    return;
  }

  if (registered.kind === "bridge") {
    await recordBridgePrequote(toolId, sessionId, registered.provider, params, resultData, context);
    return;
  }
  if (registered.kind === "pendle") {
    await recordPendlePrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  if (registered.kind === "pendle-py") {
    await recordPendlePyPrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  if (registered.kind === "pendle-lp") {
    await recordPendleLpPrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  if (registered.kind === "morpho-lend") {
    await recordMorphoLendPrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  if (registered.kind === "morpho-borrow") {
    await recordMorphoBorrowPrequote(toolId, sessionId, registered, params, resultData, context);
    return;
  }
  await recordSwapPrequote(toolId, sessionId, registered, params, resultData, context);
}
