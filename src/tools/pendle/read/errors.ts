/**
 * Error mapping for the Pendle READ surface.
 *
 * Same WAVE-3 doctrine as `tools/pendle/errors.ts`: the upstream body is HOSTILE
 * input. It is never inspected for text to re-emit and never copied into a
 * thrown message — every message here comes from our own static vocabulary.
 *
 * TWO differences from the money-path mapper, both required by the card:
 *
 *  1. Every error carries `httpStatus` and `retryable`. A read handler must be
 *     able to tell a DEFINITIVE provider refusal (the request was understood and
 *     rejected — nothing exists) from an ambiguous transport failure, because
 *     "Pendle says there is no such market" and "I could not reach Pendle" are
 *     different facts and reporting one as the other is the exact defect
 *     rules/90 names.
 *  2. A 404 maps to `PENDLE_MARKET_NOT_FOUND`, not `PENDLE_TOKEN_NOT_FOUND`.
 *     Every read path that can 404 is market-scoped, and both live 404 bodies
 *     say so: `Given market is expired` (swapping-prices on a matured market)
 *     and `Can not find supportToken by market address` (order book on a market
 *     that is not limit-order whitelisted).
 *
 * The money-path mapper is deliberately untouched: its codes are consumed by the
 * mutating handlers' failure vocabulary.
 */

import { VexError, ErrorCodes } from "../../../errors.js";

/**
 * Map an HTTP status from a Pendle READ endpoint to a fixed, code-keyed error.
 * `endpoint` is one of OUR OWN short labels (e.g. "markets", "orderbook") — it
 * is never derived from the response.
 */
export function mapPendleReadError(status: number, endpoint: string): VexError {
  const err = buildReadError(status, endpoint);
  err.httpStatus = status;
  // Only a rate limit and a server fault can succeed on a retry. A 4xx is the
  // provider's verdict on the request itself; retrying it burns compute units
  // for the same answer.
  err.retryable = status === 429 || status >= 500;
  return err;
}

function buildReadError(status: number, endpoint: string): VexError {
  if (status === 429) {
    return new VexError(
      ErrorCodes.PENDLE_RATE_LIMITED,
      "Pendle API rate limited (HTTP 429).",
      "Pendle is self-throttled by compute units. Wait and retry.",
    );
  }
  if (status === 404) {
    return new VexError(
      ErrorCodes.PENDLE_MARKET_NOT_FOUND,
      `Pendle has no ${endpoint} data for that market (HTTP 404).`,
      "The market may be matured, may not exist on that chain, or may not be covered by this endpoint. Re-check it with pendle.yields.",
    );
  }
  if (status === 400) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      `Pendle rejected the ${endpoint} request (HTTP 400).`,
      "One of the read parameters is outside what Pendle accepts. Re-check the chain, market, time frame and field list.",
    );
  }
  if (status >= 500) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      `Pendle server error on ${endpoint} (HTTP ${status}).`,
      "Pendle server error. Try again later.",
    );
  }
  return new VexError(ErrorCodes.PENDLE_API_ERROR, `Pendle ${endpoint} returned HTTP ${status}.`);
}

/**
 * Normalize a transport-layer throw into a Pendle-coded error.
 *
 * Deliberately does NOT stamp `httpStatus`: nothing answered, so there is no
 * status, and inventing one would erase the very distinction this module exists
 * to preserve. Timeouts and connection failures ARE retryable — unlike a 4xx,
 * the request may never have been served.
 */
export function mapPendleReadTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("PENDLE_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    const mapped = new VexError(ErrorCodes.PENDLE_TIMEOUT, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    const mapped = new VexError(ErrorCodes.PENDLE_API_ERROR, err.message, err.hint);
    mapped.retryable = true;
    throw mapped;
  }
  throw err;
}
