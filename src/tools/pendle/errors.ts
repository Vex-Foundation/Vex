/**
 * Pendle API error mapping (WAVE-3 doctrine — upstream text is HOSTILE input).
 *
 * The hosted Pendle API returns `{ message, error, statusCode }` on a 400. That
 * `message`/`error` text is untrusted and must NEVER reach the thrown error
 * message (which can surface to the model). We inspect the body ONLY to CHOOSE a
 * fixed, code-keyed message — the returned VexError text is always built from our
 * own static vocabulary. The caller logs a bounded slice of the raw body as
 * metadata for debugging; it never reaches a model-facing surface.
 *
 * Known 400 bodies (live-probed 2026-07-05):
 *   - "The input valuation is too low. The minimum valuation is …"  → too-low
 *   - "The input valuation is too high. The maximum valuation is …" → too-high
 *   - "… token … in list …" / "token not found"                    → token
 *   - "Unable to classify convert action" (NO `error` field)        → expired-buy
 */

import { VexError, ErrorCodes } from "../../errors.js";

/** Narrow the untrusted 400 body to a fixed code — never copies upstream text. */
function classifyBadRequest(body: unknown): VexError {
  const message =
    body !== null && typeof body === "object" && "message" in body && typeof (body as { message: unknown }).message === "string"
      ? (body as { message: string }).message.toLowerCase()
      : "";

  if (message.includes("valuation is too low") || message.includes("minimum valuation")) {
    return new VexError(
      ErrorCodes.PENDLE_VALUATION_TOO_LOW,
      "Pendle rejected the amount: below the minimum trade size (about $0.01).",
      "Increase the amount and retry.",
    );
  }
  if (message.includes("valuation is too high") || message.includes("maximum valuation")) {
    return new VexError(
      ErrorCodes.PENDLE_VALUATION_TOO_HIGH,
      "Pendle rejected the amount: above the maximum trade size ($100M).",
      "Reduce the amount and retry.",
    );
  }
  if (message.includes("classify convert action")) {
    return new VexError(
      ErrorCodes.PENDLE_MARKET_EXPIRED,
      "Pendle could not build this trade — the market has likely expired (a matured PT can only be redeemed, not bought/sold).",
      "For a matured PT use pendle.pt.redeem; otherwise re-check the market with pendle.yields.",
    );
  }
  if (message.includes("token") && (message.includes("list") || message.includes("not found"))) {
    return new VexError(
      ErrorCodes.PENDLE_TOKEN_NOT_FOUND,
      "Pendle does not recognize one of the tokens for this route.",
      "Verify the PT / payment-token addresses with pendle.yields, then retry.",
    );
  }
  return new VexError(
    ErrorCodes.PENDLE_API_ERROR,
    "Pendle rejected the request.",
    "Re-check the trade parameters and retry.",
  );
}

/**
 * Map an HTTP status (+ optional untrusted body for 400 classification) to a
 * fixed, code-keyed VexError. No upstream text is ever embedded.
 */
export function mapPendleError(status: number, body?: unknown): VexError {
  if (status === 429) {
    const err = new VexError(
      ErrorCodes.PENDLE_RATE_LIMITED,
      "Pendle API rate limited (HTTP 429).",
      "Pendle is self-throttled by compute units. Wait and retry.",
    );
    err.retryable = true;
    return err;
  }
  if (status === 400) {
    return classifyBadRequest(body);
  }
  if (status === 404) {
    return new VexError(
      ErrorCodes.PENDLE_TOKEN_NOT_FOUND,
      "Pendle resource not found (HTTP 404).",
      "Verify the market / token / wallet and retry.",
    );
  }
  if (status >= 500) {
    const err = new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      `Pendle server error (HTTP ${status}).`,
      "Pendle server error. Try again later.",
    );
    err.retryable = true;
    return err;
  }
  return new VexError(ErrorCodes.PENDLE_API_ERROR, `Pendle API returned HTTP ${status}.`);
}

/**
 * The provider answered, but not in a shape we can read. This is deliberately a
 * THROW and not a degraded empty result: "Pendle says the collection is empty"
 * and "Pendle sent something I cannot parse" are different facts, and conflating
 * them is what let `/v1/assets/all` return `[]` on every call for months — every
 * token silently 18-decimal, every cost basis $0, every PT invisible in the
 * portfolio, with nothing logged.
 *
 * `detail` MUST come from our own static vocabulary — never from the upstream
 * body, which is hostile input (see the module header).
 */
export function pendleInvalidResponse(endpoint: string, detail: string): VexError {
  return new VexError(
    ErrorCodes.PENDLE_INVALID_RESPONSE,
    `Pendle returned an unreadable ${endpoint} response (${detail}).`,
    "Pendle changed a response shape Vex depends on. This is a provider-side fault; "
    + "retrying with different parameters will not help. Use another source for this data.",
  );
}

/** Normalize a transport-layer throw into a Pendle-coded VexError. */
export function mapPendleTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("PENDLE_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw new VexError(ErrorCodes.PENDLE_TIMEOUT, err.message, err.hint);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw new VexError(ErrorCodes.PENDLE_API_ERROR, err.message, err.hint);
  }
  throw err;
}
