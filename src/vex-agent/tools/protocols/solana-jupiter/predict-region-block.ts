/**
 * Solana/Jupiter prediction-market regional-block error mapping.
 *
 * Jupiter Prediction Markets are geo-blocked product-wide for US/South Korea
 * IPs (developers.jup.ag/docs/prediction: "United States and South Korea IPs
 * are blocked ... entirely, product-level"). A geo-block is not actionable for
 * an agent narrating this to a self-custodial user unless it is named, so this
 * maps the conventional 403 status — the standard HTTP code for a
 * permission-denied response, matching the docs' `permission_error` category —
 * to a clear message. No live geo-blocked capture exists (none of the recorded
 * fixtures were taken from a blocked region), so ONLY the status is matched;
 * every other error passes through untouched to the existing redacted-summary
 * path. If live evidence ever shows a different status, this silently never
 * fires (safe no-regression degrade to the provider's own message), not a
 * broken feature.
 *
 * The status comes from `VexError.httpStatus`, which `parseJsonResponse`
 * (utils/http.ts) sets on every non-ok response. It must NOT be re-parsed out
 * of the message text: `parseJsonResponse` now surfaces the provider's OWN
 * reason string when the body carries one (the prediction API answers
 * `{type, message}`), so the message no longer reliably begins with
 * "HTTP 403" — `httpStatus` is exactly what that field was added to carry.
 *
 * Introduced in `handlers/predict.ts` (W1-C) for its own 5 reads
 * (events/search/event/positions/history). Moved to this dedicated module
 * (P1) once nearly every prediction read handler needed the same mapping —
 * `handlers/predict.ts`, `handlers/predict-orders.ts` (W1-D), and
 * `handlers/predict-social.ts` (W1-F) all import `wrapPredictionRead` from
 * here, mirroring the existing `predict-projector.ts`/`predict-params.ts`
 * sibling-module pattern rather than one handler file owning plumbing three
 * files depend on. FIX-D closed the last gap: `.market`/`.position` in
 * `handlers/predict.ts` now use it too, so all 18 prediction reads share this
 * one mapping.
 */
import { VexError, ErrorCodes } from "../../../../errors.js";

const PREDICTION_REGION_BLOCK_MESSAGE =
  "Jupiter Prediction Markets are not available from your current region " +
  "(the product blocks United States and South Korea IP addresses).";

function isPredictionRegionBlock(err: unknown): boolean {
  return err instanceof VexError && err.httpStatus === 403;
}

/** Wrap a prediction read call, rewriting a region-block into a clear message. */
export async function wrapPredictionRead<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (isPredictionRegionBlock(err)) {
      throw new VexError(ErrorCodes.HTTP_REQUEST_FAILED, PREDICTION_REGION_BLOCK_MESSAGE);
    }
    throw err;
  }
}
