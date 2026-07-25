/**
 * Solana/Jupiter prediction pre-trade visibility & order handlers (W1-D).
 *
 * New read-only tools wired from the existing SDK surface — orderbook,
 * trading-status, orders (list/single/status), and the global trade feed.
 * Every SDK client/service function these call already existed
 * (`prediction-api/client/read.ts` + `service.ts`); this card only adds the
 * agent-facing manifest + handler layer on top. Money/limit conventions
 * match W1-B (exact-decimal USD string + `*Micro` raw sibling) and W1-C
 * (reject-not-clamp `limit`/`offset` window, shared via
 * `resolvePredictionWindow`).
 *
 * Kept in a SIBLING file, not `handlers/predict.ts` — that file is already at
 * 470/500 lines per W1-C's own delta log, and `recon-prediction-packets.md`
 * (Packet D) explicitly recommends a new handler file here to stay under the
 * factory's 500-line hard cap.
 *
 * Regional-block mapping (P1): every read below is wrapped in
 * `wrapPredictionRead` (`../predict-region-block.js`), the same 403→clear-
 * message mapping `handlers/predict.ts` introduced (W1-C) for its own reads.
 */

import {
  getJupiterPredictionOrderbook,
  getJupiterPredictionTradingStatus,
  getJupiterPredictionOrders,
  getJupiterPredictionOrder,
  getJupiterPredictionOrderStatus,
  getJupiterPredictionTrades,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js";

import type { ProtocolHandler } from "../../types.js";
import { str, num, ok, fail } from "../../handler-helpers.js";
import { walletAddress } from "./core.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { resolvePredictionWindow } from "../predict-params.js";
import { projectPredictionOrder, projectPredictionTrade } from "../predict-projector.js";
import { wrapPredictionRead } from "../predict-region-block.js";

export const PREDICT_ORDER_HANDLERS: Record<string, ProtocolHandler> = {
  "solana.predict.orderbook": async (p) => {
    const marketId = str(p, "marketId");
    if (!marketId) return fail("Missing required: marketId");
    const orderbook = await wrapPredictionRead(() => getJupiterPredictionOrderbook(marketId));
    // Docs: the response body can be a literal `null` when Jupiter's own
    // upstream orderbook-data fetch fails (its documented 502 semantic) — a
    // real, expected "no data" case. `{...null}` silently degrades to an
    // empty object in JS, so this is checked explicitly instead of letting
    // that happen.
    if (orderbook === null) {
      return fail(
        `Orderbook data is temporarily unavailable for market ${marketId} (upstream data fetch failed). Try again shortly.`,
      );
    }
    // yes_dollars/no_dollars are already decimal-dollar mirrors of yes/no
    // (native price-level units) — no unit-scale risk here, unlike W1-B's
    // targets (see predict-projector.ts's header + W1-B's DOCS-GAP note on
    // orderbook's native array NOT being a linear micro-USD scale). Passed
    // through in full — depth-array length is uncapped upstream (no
    // limit/depth param exists) and the owner rule forbids inventing a
    // silent client-side cap.
    return ok(orderbook);
  },

  "solana.predict.tradingStatus": async () => ok(await wrapPredictionRead(() => getJupiterPredictionTradingStatus())),

  "solana.predict.orders": async (p, ctx) => {
    let owner: string;
    try {
      owner = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const window = resolvePredictionWindow(p);
    if (!window.ok) return window.result;
    // No server-side status/marketId/side filter exists upstream (confirmed
    // absent from the OpenAPI spec) — this returns the owner's full order
    // list within the requested window, unfiltered beyond that.
    const result = await wrapPredictionRead(() => getJupiterPredictionOrders({
      ownerPubkey: owner,
      start: window.start,
      end: window.end,
    }));
    return ok({ ...result, data: result.data.map(projectPredictionOrder) });
  },

  "solana.predict.order": async (p) => {
    const orderPubkey = str(p, "orderPubkey");
    if (!orderPubkey) return fail("Missing required: orderPubkey");
    return ok(projectPredictionOrder(await wrapPredictionRead(() => getJupiterPredictionOrder(orderPubkey))));
  },

  "solana.predict.orderStatus": async (p) => {
    const orderPubkey = str(p, "orderPubkey");
    if (!orderPubkey) return fail("Missing required: orderPubkey");
    return ok(await wrapPredictionRead(() => getJupiterPredictionOrderStatus(orderPubkey)));
  },

  "solana.predict.trades": async (p) => {
    // Owner rule: no default-N truncation. `/trades` is a GLOBAL, unfiltered
    // feed with ZERO upstream params (no owner/market/time scope, no
    // pagination) — unlike `.orders`/`.events`/`.positions`/`.history`,
    // each naturally scoped to one wallet or one market, silently defaulting
    // this window to 20 would truncate an unbounded response the agent never
    // asked to bound. `limit` is REQUIRED here (F2); `resolvePredictionWindow`'s
    // own default-20 branch never fires because this rejects first.
    if (num(p, "limit") == null) {
      return fail(
        "Missing required: limit. solana.predict.trades has no upstream scope (global feed) — an explicit limit (1-100) is required.",
      );
    }
    const window = resolvePredictionWindow(p);
    if (!window.ok) return window.result;
    // `/trades` is a global, unfiltered feed with ZERO upstream params (no
    // owner/market/time scope, no pagination) — the whole feed is fetched
    // every call regardless, and THIS handler imposes the agent-controlled
    // window client-side. Not a silent/undisclosed cap: the manifest states
    // the required window explicitly (same convention as every other list
    // tool in this domain) and an out-of-range limit/offset is rejected,
    // never clamped.
    const result = await wrapPredictionRead(() => getJupiterPredictionTrades());
    const windowed = result.data.slice(window.start, window.end);
    return ok({
      data: windowed.map(projectPredictionTrade),
      pagination: {
        start: window.start,
        end: window.end,
        total: result.data.length,
        hasNext: window.end < result.data.length,
      },
    });
  },
};
