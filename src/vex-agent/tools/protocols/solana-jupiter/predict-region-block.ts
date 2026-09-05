/**
 * Solana/Jupiter prediction-market regional-block error mapping.
 *
 * Jupiter Prediction Markets are geo-blocked product-wide for US/South Korea
 * IPs (developers.jup.ag/docs/prediction: "United States and South Korea IPs
 * are blocked ... entirely, product-level"). A geo-block is not actionable for
 * an agent narrating this to a self-custodial user unless it is named, so this
 * maps the conventional 403 status - the standard HTTP code for a
 * permission-denied response, matching the docs' `permission_error` category -
 * to a clear message. No live geo-blocked capture exists (none of the recorded
 * fixtures were taken from a blocked region), so ONLY the status is matched;
 * every other error passes through untouched to the existing redacted-summary
 * path. If live evidence ever shows a different status, this silently never
 * fires (safe no-regression degrade to the provider's own message), not a
 * broken feature.
 *
 * W2g - APPEND, NEVER REPLACE. Until this wave the mapping REWROTE every 403
 * into the geo sentence and dropped `httpStatus` with it, so an entitlement
 * 403, a non-geographic IP ban and a WAF refusal all reached the agent as "you
 * are in the US" - a confident wrong cause on a status that proves only that
 * the provider refused. Because no geo-blocked capture exists, a 403 is not
 * evidence of a geo-block; it is evidence of a refusal whose most likely known
 * cause is one. So the provider's own (already scrubbed) sentence stays first
 * and the geo-block is appended as a named possibility, with the status
 * preserved - see `../provider-error-hint.ts`.
 *
 * The status comes from `VexError.httpStatus`, which `parseJsonResponse`
 * (utils/http.ts) sets on every non-ok response. It must NOT be re-parsed out
 * of the message text: `parseJsonResponse` now surfaces the provider's OWN
 * reason string when the body carries one (the prediction API answers
 * `{type, message}`), so the message no longer reliably begins with
 * "HTTP 403" - `httpStatus` is exactly what that field was added to carry.
 *
 * Introduced in `handlers/predict.ts` (W1-C) for its own 5 reads
 * (events/search/event/positions/history). Moved to this dedicated module
 * (P1) once nearly every prediction read handler needed the same mapping -
 * `handlers/predict.ts`, `handlers/predict-orders.ts` (W1-D), and
 * `handlers/predict-social.ts` (W1-F) all import `wrapPredictionRead` from
 * here, mirroring the existing `predict-projector.ts`/`predict-params.ts`
 * sibling-module pattern rather than one handler file owning plumbing three
 * files depend on. FIX-D closed the last gap: `.market`/`.position` in
 * `handlers/predict.ts` now use it too, so all 18 prediction reads share this
 * one mapping.
 */
import { appendProviderHint } from "./provider-error-hint.js";

/**
 * Appended after the provider's own words, never in place of them. Phrased as
 * the known cause of THIS status rather than as a verdict, because a 403 does
 * not distinguish a geo-block from an entitlement, quota or WAF refusal.
 */
const PREDICTION_REGION_BLOCK_HINT =
  "(Jupiter refused this read with 403. The known product-level cause is region: " +
  "Jupiter Prediction Markets block United States and South Korea IP addresses entirely. " +
  "An entitlement, quota or WAF refusal also answers 403 - read the provider's own words above.)";

/** Wrap a prediction read call, appending the region-block hint to a 403. */
export async function wrapPredictionRead<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw appendProviderHint(err, 403, PREDICTION_REGION_BLOCK_HINT);
  }
}
