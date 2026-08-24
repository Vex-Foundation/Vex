/**
 * Solana/Jupiter prediction discovery & social handlers (W1-F).
 *
 * New read-only tools wired from the existing SDK surface — trader profile,
 * PnL history, leaderboards, vault state, and personalized event
 * recommendations. Every SDK client/service function these call already
 * existed (`prediction-api/client/read.ts` + `service.ts`); this card only
 * adds the agent-facing manifest + handler layer on top, mirroring W1-D's
 * `handlers/predict-orders.ts` split — a new sibling file rather than growing
 * `handlers/predict.ts` further past its already-flagged line budget. Money
 * conventions match W1-B (exact-decimal USD string + `*Micro` raw sibling);
 * `.profile`/`.pnlHistory` reuse the domain's `walletAddress` "my own data"
 * resolution idiom already used by `.positions`/`.history`/`.orders`, since
 * both are trader-scoped stats. `.suggestedEvents` takes an explicit `pubkey`
 * instead (no wallet-default fallback) — per the docs it can target any
 * pubkey's recommendations, not only the caller's own wallet, matching the
 * domain's other explicit-lookup-key tools (`.order`/`.position`).
 *
 * Regional-block mapping (P1): every read below is wrapped in
 * `wrapPredictionRead` (`../predict-region-block.js`), the same 403→clear-
 * message mapping `handlers/predict.ts` introduced (W1-C) for its own reads.
 */

import {
  getJupiterPredictionProfile,
  getJupiterPredictionPnlHistory,
  getJupiterPredictionLeaderboards,
  getJupiterPredictionVaultInfo,
  getJupiterPredictionSuggestedEvents,
} from "@tools/solana-ecosystem/jupiter/jupiter-prediction/prediction-api/service.js";

import type { ProtocolHandler } from "../../types.js";
import { str, num, bool, ok, fail } from "../../handler-helpers.js";
import { walletAddress } from "./core.js";
import { walletScopeErrorToResult } from "@vex-agent/tools/internal/wallet/resolve.js";
import {
  toPredictView,
  projectPredictionProfile,
  projectPredictionPnlHistoryPoint,
  projectPredictionLeaderboardEntry,
  projectPredictionLeaderboardsSummary,
} from "../predict-projector.js";
import { strictEnumField } from "../predict-params.js";
import { wrapPredictionRead } from "../predict-region-block.js";
import { appendProviderHint } from "../provider-error-hint.js";

// ── SDK enum mirrors ──────────────────────────────────────────────
// Source: `JupiterPredictionProvider`/`JupiterPredictionPnlInterval`/
// `JupiterPredictionLeaderboardPeriod`/`JupiterPredictionLeaderboardMetric` in
// `prediction-api/types/base.ts` (same local-mirror convention already used by
// `handlers/predict.ts`).
const PREDICT_PROVIDER = ["kalshi", "polymarket", "bisonfi"] as const;
const PREDICT_PNL_INTERVAL = ["24h", "1w", "1m"] as const;
const PREDICT_LEADERBOARD_PERIOD = ["all_time", "weekly", "monthly"] as const;
const PREDICT_LEADERBOARD_METRIC = ["pnl", "volume", "win_rate"] as const;

/**
 * LIVE-GATE (2026-07-24, LIVE-FIX-1 + coordinator/Codex correction): the
 * documented `GET /profiles/{pubkey}/pnl-history` route returns a bare 404
 * live for every pubkey — including real active traders off `/leaderboards`
 * whose `/profiles/{pubkey}` 200s — so it is not a "no history yet" case. The
 * coordinator then verified it is NOT a removal or a stale client path either:
 * Jupiter's current docs/OpenAPI still publish this exact route (200 only), and
 * the 404 reproduces on BOTH api.jup.ag AND the direct prediction-market-api
 * host, where `profile` still 200s. Conclusion: a provider-side outage or stale
 * docs. Map the opaque 404 to an honest, transient-framed failure; do NOT
 * repoint the client or hide the tool (it may be restored upstream).
 */
// Jupiter's OWN docs still publish this route (developers.jup.ag Get-PnL-History
// reference, Social-Features page, and the current prediction.yaml OpenAPI —
// verified 2026-07-24, they document only a 200, no 404). Yet a live
// authenticated call returns 404 on BOTH the public gateway (api.jup.ag) AND
// the direct service host (prediction-market-api.jup.ag) for a real trader who
// HAS prediction history and whose `profile` returns 200 on both hosts. So this
// is a provider-side outage or stale documentation, NOT an endpoint removal and
// NOT a stale client path — do not repoint or hide the tool; report honestly
// and let the agent fall back to `profile`.
//
// W2g — APPEND, NEVER REPLACE. This used to REWRITE every 404 into the outage
// sentence and drop `httpStatus` with it. A 404 is evidence the provider
// answered and did not find the route or the resource; it is not evidence of
// WHICH, and Jupiter is free to start answering "no history for this wallet"
// on the same status. So the provider's own (scrubbed) words stay first and
// the known-outage note is appended as context, with the status preserved.
const PNL_HISTORY_UNAVAILABLE_HINT =
  "(Jupiter answered 404 on the documented pnl-history route. Since 2026-07-24 that route " +
  "has returned 404 for every wallet, including traders whose solana__predict_profile_get returns " +
  "200 — a provider-side outage or stale docs, not a Vex error. Retry later, or use " +
  "solana__predict_profile_get for a lifetime PnL snapshot now.)";

export const PREDICT_SOCIAL_HANDLERS: Record<string, ProtocolHandler> = {
  "solana.predict.profile": async (p, ctx) => {
    let owner: string;
    try {
      owner = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    return ok(projectPredictionProfile(await wrapPredictionRead(() => getJupiterPredictionProfile(owner))));
  },

  "solana.predict.pnlHistory": async (p, ctx) => {
    let owner: string;
    try {
      owner = walletAddress(p, ctx);
    } catch (err) {
      return walletScopeErrorToResult(err);
    }
    // Required per the docs/OpenAPI spec — reject before the SDK call rather
    // than letting an omitted/invalid interval reach the wire as an
    // unexplained 400. strictEnumField (F2) distinguishes "absent" from
    // "present but invalid" so the message is always precise.
    const intervalResult = strictEnumField(p, "interval", PREDICT_PNL_INTERVAL);
    if (!intervalResult.ok) return intervalResult.result;
    if (!intervalResult.value) {
      return fail(`Missing required: interval. interval must be one of: ${PREDICT_PNL_INTERVAL.join(", ")}.`);
    }
    // Owner-wide cap (F2): the SDK's own validator allows up to 1000
    // (`assertIntegerInRange("count", ..., 1, 1000)`), but Vex's product-wide
    // limit policy caps every agent-controlled count/limit at 100 — reject
    // above 100 rather than silently letting a bigger value reach the wire.
    const count = num(p, "count");
    if (count != null && (!Number.isInteger(count) || count < 1 || count > 100)) {
      return fail(`Invalid count: ${count}. count must be an integer between 1 and 100.`);
    }
    let result;
    try {
      result = await wrapPredictionRead(() => getJupiterPredictionPnlHistory({
        ownerPubkey: owner,
        interval: intervalResult.value,
        count,
      }));
    } catch (err) {
      throw appendProviderHint(err, 404, PNL_HISTORY_UNAVAILABLE_HINT);
    }
    return ok({ ...result, history: result.history.map(projectPredictionPnlHistoryPoint) });
  },

  "solana.predict.leaderboards": async (p) => {
    // period/metric/limit are all required per the docs/OpenAPI spec (the
    // SDK itself models them as optional for defensive flexibility) — reject
    // here with a clear, specific message instead of letting an omitted or
    // invalid field reach the wire as an unexplained 400. `limit`'s 1-100
    // range is already enforced by the SDK's own validator once present.
    const periodResult = strictEnumField(p, "period", PREDICT_LEADERBOARD_PERIOD);
    if (!periodResult.ok) return periodResult.result;
    if (!periodResult.value) {
      return fail(`Missing required: period. period must be one of: ${PREDICT_LEADERBOARD_PERIOD.join(", ")}.`);
    }
    const metricResult = strictEnumField(p, "metric", PREDICT_LEADERBOARD_METRIC);
    if (!metricResult.ok) return metricResult.result;
    if (!metricResult.value) {
      return fail(`Missing required: metric. metric must be one of: ${PREDICT_LEADERBOARD_METRIC.join(", ")}.`);
    }
    const limit = num(p, "limit");
    if (limit == null) return fail("Missing required: limit (integer, 1-100).");
    const result = await wrapPredictionRead(() => getJupiterPredictionLeaderboards({ period: periodResult.value, metric: metricResult.value, limit }));
    return ok({
      data: result.data.map(projectPredictionLeaderboardEntry),
      summary: projectPredictionLeaderboardsSummary(result.summary),
    });
  },

  "solana.predict.vaultInfo": async () => ok(await wrapPredictionRead(() => getJupiterPredictionVaultInfo())),

  "solana.predict.suggestedEvents": async (p) => {
    const pubkey = str(p, "walletAddress");
    if (!pubkey) return fail("Missing required: walletAddress");
    const provider = strictEnumField(p, "provider", PREDICT_PROVIDER);
    if (!provider.ok) return provider.result;
    // Lean markets (same convention as .events/.search/.event, W1-C): the
    // toggle below only controls what OUR projector keeps from the
    // already-fetched response. This endpoint's SDK client
    // (`getJupiterPredictionSuggestedEvents`) does not forward an
    // includeMarkets query param upstream at all today — a genuine SDK-layer
    // gap, not the provider ignoring the param (CORRECTED, F2, see
    // fixtures/prediction-events-search.meta.md CORRECTION: the earlier
    // "includeMarkets is a live no-op domain-wide" claim was a rate-limit
    // artifact of keyless probing, not real provider behavior). The
    // agent-facing lean-by-default contract is unaffected either way.
    const includeMarkets = bool(p, "includeMarkets") ?? false;
    const result = await wrapPredictionRead(() => getJupiterPredictionSuggestedEvents({
      pubkey,
      provider: provider.value,
    }));
    return ok({ data: result.data.map((item) => toPredictView(item, { includeMarkets })) });
  },
};
