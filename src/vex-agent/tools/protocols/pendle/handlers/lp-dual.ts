/**
 * Pendle DUAL-LP handlers (R5d card E3) — `pendle.lp.removeDual` (LP → token +
 * PT) and `pendle.lp.addKeepYt` (token → LP + kept YT).
 *
 * This file is the dual-LP family's PUBLIC ENTRY POINT; each tool's
 * implementation lives in `./lp-dual/`, and what they share (activity role, tool
 * ids, the by-token quoted-leg read, the exact-approval helper) in
 * `./lp-dual/dual-legs.ts`.
 *
 * ONE second output leg is what separates these two from the shipped
 * single-token `handlers/lp.ts` pair, and it changes four things end to end:
 *
 *   1. THE PRICE FLOOR is per leg. `removeLiquidityDualTokenAndPt` carries a
 *      `minTokenOut` AND a `minPtOut`; `addLiquiditySingleTokenKeepYt` a
 *      `minLpOut` AND a `minYtOut`. Both rows are already in
 *      `calldata/price-floor.ts`, and both resolve their leg BY TOKEN rather
 *      than by index, because the provider's `outputs` order is its own (measured
 *      2026-07-28: asking `[underlying, PT]` and `[PT, underlying]` both came
 *      back `[PT, underlying]`). This family reads its own quoted amounts the
 *      same way — by token, never positionally.
 *   2. THE DURABLE ROW carries an Option-C second leg (migration 053), which
 *      `yield_lp` permits. The INTENT stages it, so the row states both
 *      instruments before a signature exists rather than discovering the second
 *      one afterwards.
 *   3. THE RECEIPT must prove BOTH. `decodePendleSettlement` requires a proven
 *      inflow for `tokenOut2` whenever the plan names one, so a confirmed dual
 *      row can never report one leg and invent the other — an unprovable second
 *      leg leaves the row pending for the repair sweep instead.
 *   4. THE ACTION BIND. Convert labels a keep-YT add plain `"add-liquidity"` —
 *      the SAME string a single-token add returns — so the response's action
 *      field cannot tell them apart. What can, and does, is the METHOD row in
 *      `calldata/bind-route.ts`: an `lp-add-keep-yt` intent accepts only
 *      `addLiquiditySingleTokenKeepYt` calldata.
 *
 * MATURITY follows the R5b matrix by SHAPE, not by family. The dual remove is
 * exit-shaped, so it resolves matured markets through
 * `resolveExitMarketByAddress` exactly as `pendle.lp.remove` does. The keep-YT
 * add is buy-shaped — liquidity cannot be added after expiry at all — so it stays
 * ACTIVE-ONLY and names maturity as the refusal reason through
 * `explainUnresolvedPendleMarket`, reusing the `lp.add` refusal because the next
 * step it recommends is the correct one for this tool too.
 *
 * PREQUOTE — the DRY-RUN-IN-TOOL pattern. A `dryRun: true` call quotes through
 * Convert, runs the FULL fund-safety extractor, records the authorization, and
 * broadcasts nothing; the execute re-fetches, re-runs every check, and is refused
 * unless a fresh dry run with IDENTICAL params exists. See `./lp-dual-prequote.ts`.
 *
 * Upstream error text NEVER reaches the model — only bounded, code-keyed detail.
 */

import type { ProtocolHandler } from "../../types.js";

import { ADD_KEEP_YT_TOOL_ID, REMOVE_DUAL_TOOL_ID } from "./lp-dual/dual-legs.js";
import { executePendleLpRemoveDual } from "./lp-dual/remove-dual.js";
import { executePendleLpAddKeepYt } from "./lp-dual/add-keep-yt.js";

export const PENDLE_LP_DUAL_HANDLERS: Record<string, ProtocolHandler> = {
  [REMOVE_DUAL_TOOL_ID]: (p, ctx) => executePendleLpRemoveDual(p, ctx),
  [ADD_KEEP_YT_TOOL_ID]: (p, ctx) => executePendleLpAddKeepYt(p, ctx),
};
