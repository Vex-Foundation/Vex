/**
 * Pendle LP handlers — quote (read) + single-token add / remove (mutating).
 *
 * This file is the single-token LP family's PUBLIC ENTRY POINT; each tool's
 * implementation lives in `./lp/`, and the capture identity they share in
 * `./lp/position-keys.ts`.
 *
 * `pendle.lp.add` deposits ONE payment token into a Pendle market and receives the
 * market's LP token (Convert action `add-liquidity`, `addLiquiditySingleToken`).
 * `pendle.lp.remove` burns the LP token back to ONE output token (Convert action
 * `remove-liquidity`, `removeLiquiditySingleToken`). The MARKET address IS the LP
 * token; it is the anchor bound end-to-end (instrument guard → identity → calldata).
 *
 * Both mutating paths mirror the PT/YT/PY discipline: fresh Convert re-fetch →
 * `selectSafeRoute` fund-safety extractor (Router pin, receiver == wallet, market ==
 * quoted, exact spend, EXACT approval set — add approves the input token, remove
 * approves the LP/market token) → exact allowance to the pinned Router → broadcast.
 * They are approval-gated + prequote-gated (add → kind `lp_add`; remove → kind
 * `lp_remove`).
 *
 * Capture writes a plain `proj_activity` row (`type:"lp"`, with a per-chain
 * `positionKey` for provenance and a protocol-neutral `meta.lpLegs` block for the
 * recorded amounts) — NOT a position projection. Agent Scan Phase 1 retired
 * LP-lifecycle tracking and LP economics (`sync/projectors/lp.ts` and
 * `db/repos/lp-events.ts` deleted): `position-projector.ts`'s `lp` case is now a
 * no-op, so neither add nor remove opens/closes a tracked position or writes
 * LP-economics rows — the agent reads recorded amounts back via `AgentScan`'s
 * `transactions`/`activity` views instead. Upstream error text NEVER reaches the model.
 */

import type { ProtocolHandler } from "../../types.js";

import { pendleLpQuote } from "./lp/quote.js";
import { executePendleLpAdd } from "./lp/add.js";
import { executePendleLpRemove } from "./lp/remove.js";

export const PENDLE_LP_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.lp.quote": (p, ctx) => pendleLpQuote(p, ctx),
  "pendle.lp.add": (p, ctx) => executePendleLpAdd(p, ctx),
  "pendle.lp.remove": (p, ctx) => executePendleLpRemove(p, ctx),
};
