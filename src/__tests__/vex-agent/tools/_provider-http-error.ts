/**
 * Shared fixture: a `VexError` shaped exactly as `parseJsonResponse`
 * (`utils/http.ts`) produces it for a non-ok provider response.
 *
 * The load-bearing part is `httpStatus`. Status-dependent mappings — the
 * Jupiter Prediction geo-block (`predict-region-block.ts`) and the pnl-history
 * upstream outage (`handlers/predict-social.ts`) — branch on that field rather
 * than parsing `/^HTTP \d+/` out of the message, because `parseJsonResponse`
 * surfaces the PROVIDER'S OWN reason string whenever the error body carries one
 * (Jupiter Prediction answers `{type, message}`), so the message no longer
 * reliably begins with a status line at all.
 *
 * A fixture that omits `httpStatus` is not a real provider error and would let
 * a status-branching regression pass unnoticed.
 */

import { VexError, ErrorCodes } from "../../../errors.js";

export function providerHttpError(status: number, message: string): VexError {
  const err = new VexError(ErrorCodes.HTTP_REQUEST_FAILED, message);
  err.httpStatus = status;
  return err;
}
