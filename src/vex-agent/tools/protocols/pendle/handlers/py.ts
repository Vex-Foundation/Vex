/**
 * Pendle PY handlers — quote (read) + mint / pre-expiry redeem (mutating).
 *
 * This file is the PY family's PUBLIC ENTRY POINT; each tool's implementation
 * lives in `./py/`.
 *
 * PY = the PT+YT pair. `pendle.py.mint` splits ONE payment token into an EQUAL
 * amount of PT and YT in a single transaction (Convert action `mint-py`,
 * `mintPyFromToken`). `pendle.py.redeem` burns an EQUAL PT+YT pair back to a token
 * BEFORE expiry (Convert action `redeem-py`, `redeemPyToToken`) — distinct from
 * `pendle.pt.redeem`, which redeems a MATURED PT (PT only, no YT).
 *
 * Both mutating paths mirror the PT/YT discipline: fresh Convert re-fetch →
 * `selectSafeRoute` fund-safety extractor (Router pin, receiver == wallet, YT ==
 * quoted, exact spend, EXACT approval set) → exact allowance(s) to the pinned
 * Router → broadcast. They are approval-gated + prequote-gated (mint → kind
 * `mint`; redeem → kind `redeem_py`).
 *
 * Capture: ONE execution, TWO capture items (a PT leg + a YT leg) with DISTINCT
 * instrument keys, so the portfolio ledger opens/closes the PT lot and the YT lot
 * separately. Amounts are RAW base-unit strings; the input (mint) / output
 * (redeem) token and its USD value are split across the two legs proportionally to
 * each leg's USD (50/50 fallback when a leg is unpriced). Upstream error text NEVER
 * reaches the model.
 */

import type { ProtocolHandler } from "../../types.js";

import { pendlePyQuote } from "./py/quote.js";
import { executePendleMint } from "./py/mint.js";
import { executePendleRedeemPy } from "./py/redeem.js";

export const PENDLE_PY_HANDLERS: Record<string, ProtocolHandler> = {
  "pendle.py.quote": (p, ctx) => pendlePyQuote(p, ctx),
  "pendle.py.mint": (p, ctx) => executePendleMint(p, ctx),
  "pendle.py.redeem": (p, ctx) => executePendleRedeemPy(p, ctx),
};
