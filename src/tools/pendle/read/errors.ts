/**
 * Error mapping for the Pendle READ surface.
 *
 * Same contract as `tools/pendle/errors.ts`, including its W2e doctrine change:
 * the provider's own words ARE carried (bounded here, sanitized downstream by
 * `utils/error-summary.ts`, the single owner of redaction). The read lane used
 * to drop the body entirely — `mapPendleReadError(status, endpoint)` was called
 * with the parsed body sitting unused in the caller's `logger.warn` — so a
 * NestJS validation 400 naming the offending field (`"timeFrame must be either
 * hour, day or week"`) reached the agent as a generic sentence about "one of
 * the read parameters".
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
 * The money-path mapper keeps its own codes: they are consumed by the mutating
 * handlers' failure vocabulary.
 */

import { VexError, ErrorCodes } from "../../../errors.js";
import { readPendleErrorMessage } from "../errors.js";

/**
 * Map an HTTP status from a Pendle READ endpoint to a fixed, code-keyed error.
 * `endpoint` is one of OUR OWN short labels (e.g. "markets", "orderbook") — it
 * is never derived from the response. `body` is the untrusted parsed body; only
 * its `message`/`error` text is quoted, bounded.
 */
export function mapPendleReadError(status: number, endpoint: string, body?: unknown): VexError {
  const err = buildReadError(status, endpoint, readPendleErrorMessage(body));
  err.httpStatus = status;
  // Only a rate limit and a server fault can succeed on a retry. A 4xx is the
  // provider's verdict on the request itself; retrying it burns compute units
  // for the same answer.
  err.retryable = status === 429 || status >= 500;
  return err;
}

/** `"<base>: <cause>."`, or `"<base>."` when the provider said nothing. */
function withCause(base: string, cause: string): string {
  return cause.length > 0 ? `${base}: ${cause}` : `${base}.`;
}

function buildReadError(status: number, endpoint: string, cause: string): VexError {
  if (status === 429) {
    return new VexError(
      ErrorCodes.PENDLE_RATE_LIMITED,
      withCause("Pendle API rate limited (HTTP 429)", cause),
      "Pendle is self-throttled by compute units. Wait and retry.",
    );
  }
  if (status === 404) {
    return new VexError(
      ErrorCodes.PENDLE_MARKET_NOT_FOUND,
      withCause(`Pendle has no ${endpoint} data for that market (HTTP 404)`, cause),
      "The market may be matured, may not exist on that chain, or may not be covered by this endpoint. Re-check it with pendle.yields.",
    );
  }
  if (status === 400) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle rejected the ${endpoint} request (HTTP 400)`, cause),
      "Pendle names the rejected parameter above when it can. Fix that parameter — re-check the chain, market, time frame and field list; retrying unchanged returns the same refusal.",
    );
  }
  if (status === 401) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle refused the ${endpoint} request as unauthenticated (HTTP 401)`, cause),
      "This Pendle endpoint now requires an API key and Vex has none configured for it. Retrying cannot succeed — report it and use another source for this data.",
    );
  }
  if (status === 402) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle refused the ${endpoint} request pending payment (HTTP 402)`, cause),
      "The Pendle API plan behind this endpoint is out of quota or unpaid. Retrying cannot succeed — report it and use another source for this data.",
    );
  }
  if (status === 403) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle forbade the ${endpoint} request (HTTP 403)`, cause),
      "Pendle's edge or plan denies this endpoint to Vex's client — the read parameters are not the problem. Do not retry unchanged; report it.",
    );
  }
  if (status === 409) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle reports a conflicting ${endpoint} state (HTTP 409)`, cause),
      "The market or order state moved while this request was in flight. Re-read it with pendle.yields rather than replaying this call.",
    );
  }
  if (status === 422) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle rejected the ${endpoint} parameters (HTTP 422)`, cause),
      "A parameter is well-formed but not acceptable to Pendle. Fix the parameter Pendle names above — retrying it unchanged returns the same refusal.",
    );
  }
  if (status >= 500) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle server error on ${endpoint} (HTTP ${status})`, cause),
      "Pendle server error. Try again later.",
    );
  }
  return new VexError(ErrorCodes.PENDLE_API_ERROR, withCause(`Pendle ${endpoint} returned HTTP ${status}`, cause));
}

/**
 * Normalize a transport-layer throw into a Pendle-coded error.
 *
 * Never INVENTS an `httpStatus`: nothing answered, so there is no status, and
 * inventing one would erase the very distinction this module exists to
 * preserve. It does CARRY one the wrapped error already had — re-wrapping must
 * not destroy a status the transport layer did observe. Timeouts and connection
 * failures ARE retryable — unlike a 4xx, the request may never have been served.
 */
export function mapPendleReadTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("PENDLE_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw carryStatus(new VexError(ErrorCodes.PENDLE_TIMEOUT, err.message, err.hint), err.httpStatus);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw carryStatus(new VexError(ErrorCodes.PENDLE_API_ERROR, err.message, err.hint), err.httpStatus);
  }
  throw err;
}

/** Carry over a status the wrapped error observed, and keep it retryable. */
function carryStatus(error: VexError, status: number | undefined): VexError {
  error.retryable = true;
  if (status !== undefined) error.httpStatus = status;
  return error;
}
