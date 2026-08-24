/**
 * Solana/Jupiter prediction market handlers.
 */

import {
  getJupiterPredictionEvents,
  searchJupiterPredictionEvents,
  getJupiterPredictionMarket,
  getJupiterPredictionEvent,
  getJupiterPredictionPosition,
  getJupiterPredictionPositions,
  getJupiterPredictionHistory,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js";

import type { ProtocolHandler } from "../../types.js";
import { str, num, bool, ok, fail } from "../../handler-helpers.js";
import { walletAddress } from "./core.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import { toPredictView, projectMarketPricing } from "../predict-projector.js";
import { convertPredictionHistoryEventMoney } from "../predict-money.js";
import { SEARCH_MAX_LIMIT, resolvePredictionWindow, resolveSearchWindow, strictEnumField } from "../predict-params.js";
import { wrapPredictionRead } from "../predict-region-block.js";
import { executePredictBuy, executePredictSell, executePredictClaim } from "../predict-execute.js";
import { executePredictCloseAll } from "../predict-execute-close-all.js";

// ── SDK enum mirrors ──────────────────────────────────────────────
// Source: `JupiterPredictionProvider`/`JupiterPredictionCategory`/
// `JupiterPredictionFilter`/`JupiterPredictionSortBy`/`JupiterPredictionSortDirection`
// in `@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/types/base.ts`.
const PREDICT_PROVIDER = ["kalshi", "polymarket", "bisonfi"] as const;
const PREDICT_CATEGORY = [
  "all", "crypto", "sports", "politics", "esports", "culture", "economics", "tech",
] as const;
const PREDICT_FILTER = ["new", "live", "trending", "upcoming"] as const;
const PREDICT_SORT_BY = ["volume", "beginAt"] as const;
const PREDICT_SORT_DIRECTION = ["asc", "desc"] as const;

// ── Handler map ──────────────────────────────────────────────────

export const PREDICT_HANDLERS: Record<string, ProtocolHandler> = {
  "solana.predict.events": async (p) => {
    const window = resolvePredictionWindow(p);
    if (!window.ok) return window.result;
    const provider = strictEnumField(p, "provider", PREDICT_PROVIDER);
    if (!provider.ok) return provider.result;
    const category = strictEnumField(p, "category", PREDICT_CATEGORY);
    if (!category.ok) return category.result;
    const filter = strictEnumField(p, "filter", PREDICT_FILTER);
    if (!filter.ok) return filter.result;
    const sortBy = strictEnumField(p, "sortBy", PREDICT_SORT_BY);
    if (!sortBy.ok) return sortBy.result;
    const sortDirection = strictEnumField(p, "sortDirection", PREDICT_SORT_DIRECTION);
    if (!sortDirection.ok) return sortDirection.result;
    // Lean markets (W1-C, transport optimization P1): the agent's own
    // preference is both the projection toggle below AND, as of P1, the
    // actual upstream request — the SDK/provider genuinely honor this param
    // (CORRECTED, see fixtures/prediction-events-search.meta.md CORRECTION:
    // the earlier "the provider ignores this param" claim was a rate-limit
    // artifact of keyless probing, not real provider behavior). The projector
    // (`toPredictView`) remains the enforcement point for the agent-facing
    // contract regardless of what the provider returns.
    const includeMarkets = bool(p, "includeMarkets") ?? false;
    const result = await wrapPredictionRead(() => getJupiterPredictionEvents({
      provider: provider.value,
      category: category.value,
      subcategory: str(p, "subcategory") || undefined,
      tags: str(p, "tags") || undefined,
      sortBy: sortBy.value,
      sortDirection: sortDirection.value,
      filter: filter.value,
      includeMarkets,
      start: window.start,
      end: window.end,
    }));
    return ok({ ...result, data: result.data.map((item) => toPredictView(item, { includeMarkets })) });
  },
  "solana.predict.search": async (p) => {
    const q = str(p, "query");
    if (!q) return fail("Missing required: query");
    const window = resolveSearchWindow(p);
    if (!window.ok) return window.result;
    const provider = strictEnumField(p, "provider", PREDICT_PROVIDER);
    if (!provider.ok) return provider.result;
    // Lean markets (W1-C): search's events carry the same always-nested
    // markets[] as /events (fixture-confirmed) — same lean-by-default
    // treatment, enforced by the projector below. Unlike `.events`/`.event`
    // (P1), this preference is NOT also passed upstream: neither the docs
    // nor the SDK's `JupiterPredictionSearchEventsParams` expose an
    // `includeMarkets` query param on `/events/search` at all.
    const includeMarkets = bool(p, "includeMarkets") ?? false;
    const result = await wrapPredictionRead(() => searchJupiterPredictionEvents({
      provider: provider.value,
      query: q,
      limit: window.limit,
    }));
    // LIVE FACT (coordinator, 2026-07-24, 4s spacing): /events/search ignores
    // `limit` entirely — 1/2/20 all returned the same 10-row response. Vex
    // cannot trust the provider to honor the requested window, so the
    // agent's requested count is enforced LOCALLY by slicing the (always
    // up-to-10-row) response — still a legitimate, honored agent contract,
    // just enforced client-side instead of upstream (see resolveSearchWindow).
    const windowed = result.data.slice(0, window.limit);
    // Pagination class `bounded_non_pageable` (parameter-vocabulary.md 4.1):
    // `/events/search` has no cursor, offset or page of its own, and the slice
    // above is a real Vex-side drop. Both counts are already in hand, so the
    // reply states them rather than letting the drop be invisible.
    const totalMatched = result.data.length;
    const returned = windowed.length;
    const truncated = totalMatched > returned;
    return ok({
      data: windowed.map((item) => toPredictView(item, { includeMarkets })),
      returned,
      totalMatched,
      truncated,
      ...(truncated
        ? {
          truncationNote:
              `${totalMatched - returned} of the ${totalMatched} matching events the provider returned were `
              + `dropped by \`limit\` (${window.limit}). This search has NO continuation - no cursor, no page `
              + `- so ask a more specific \`query\``
              + (window.limit < SEARCH_MAX_LIMIT ? `, or raise \`limit\` (maximum ${SEARCH_MAX_LIMIT}).` : "."),
        }
        : {}),
    });
  },
  "solana.predict.market": async (p) => {
    const id = str(p, "marketId");
    if (!id) return fail("Missing required: marketId");
    // Regional-block mapping (FIX-D): the last of the domain's 18 reads to
    // get wrapPredictionRead — flagged as a gap in P1's delta log because it
    // pre-dates W1-C's 5-handler rollout and P1's 16-handler count.
    const market = await wrapPredictionRead(() => getJupiterPredictionMarket(id));
    return ok({ ...market, pricing: projectMarketPricing(market.pricing) });
  },
  "solana.predict.positions": async (p, ctx) => {
    let owner: string;
    try {
      owner = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const window = resolvePredictionWindow(p);
    if (!window.ok) return window.result;
    const result = await wrapPredictionRead(() => getJupiterPredictionPositions({
      ownerPubkey: owner,
      marketPubkey: str(p, "marketPubkey") || undefined,
      marketId: str(p, "marketId") || undefined,
      isYes: bool(p, "isYes"),
      start: window.start,
      end: window.end,
    }));
    return ok({ ...result, data: result.data.map((item) => toPredictView(item)) });
  },
  "solana.predict.history": async (p, ctx) => {
    let owner: string;
    try {
      owner = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    const window = resolvePredictionWindow(p);
    if (!window.ok) return window.result;
    const result = await wrapPredictionRead(() => getJupiterPredictionHistory({
      ownerPubkey: owner,
      positionPubkey: str(p, "positionPubkey") || undefined,
      id: num(p, "id"),
      start: window.start,
      end: window.end,
    }));
    return ok({ ...result, data: result.data.map(convertPredictionHistoryEventMoney) });
  },
  // buy/sell/claim/closeAll (W5 migration 049): converted to the staged
  // `agent_activity` write path — see `../predict-execute.ts`'s module doc
  // for the full write-sequence contract (`../predict-execute-close-all.ts`
  // for the N-row closeAll fan-out). `capture: "none"` in
  // mutation-matrix.ts (no more `_tradeCapture`/`_tradeCaptureItems`); every
  // outcome is truthful-pending.
  "solana.predict.buy": executePredictBuy,
  "solana.predict.sell": executePredictSell,
  "solana.predict.claim": executePredictClaim,
  "solana.predict.closeAll": executePredictCloseAll,
  "solana.predict.event": async (p) => {
    const id = str(p, "eventId");
    if (!id) return fail("Missing required: eventId");
    // Lean markets (W1-C, transport optimization P1): same treatment as
    // `.events` — the agent's preference is now also the actual upstream
    // request (see `.events`'s comment above for the correction evidence).
    const includeMarkets = bool(p, "includeMarkets") ?? false;
    const event = await wrapPredictionRead(() => getJupiterPredictionEvent({ eventId: id, includeMarkets }));
    return ok(toPredictView(event, { includeMarkets }));
  },
  "solana.predict.position": async (p) => {
    const pk = str(p, "positionPubkey");
    if (!pk) return fail("Missing required: positionPubkey");
    // Regional-block mapping (FIX-D) — see `.market`'s comment above.
    return ok(toPredictView(await wrapPredictionRead(() => getJupiterPredictionPosition(pk))));
  },
};
