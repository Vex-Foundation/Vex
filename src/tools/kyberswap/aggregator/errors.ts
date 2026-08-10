/**
 * KyberSwap Aggregator error mapping.
 *
 * Maps HTTP status codes and KyberSwap-specific error codes
 * to structured VexError instances with retryable flags.
 */

import { VexError, ErrorCodes } from "../../../errors.js";

function withMeta(error: VexError, retryable: boolean, externalName?: string): VexError {
  error.retryable = retryable;
  if (externalName) error.externalName = externalName;
  return error;
}

/**
 * The status the venue answered with, stamped on EVERY error this mapper
 * produces (SPEC §1.5, W2a).
 *
 * The aggregator client hand-rolled its body read and never set `httpStatus`,
 * so the one field the error contract classifies on before it reads any prose
 * was destroyed at the boundary: a 403 challenge page arrived at the agent as a
 * generic `provider_error` and it retried a call an edge had already refused.
 */
function withStatus(error: VexError, status: number): VexError {
  error.httpStatus = status;
  return error;
}

/**
 * Map KyberSwap Aggregator API response to VexError.
 *
 * @param status - HTTP status code
 * @param code - KyberSwap error code from response JSON (e.g. 4001, 4008)
 * @param message - Error message from response
 * @param requestId - KyberSwap requestId for debug
 */
export function mapAggregatorError(status: number, code: number | null, message: string, requestId?: string): VexError {
  const suffix = requestId ? ` [requestId: ${requestId}]` : "";

  // Auth / not-found, BEFORE the provider's own `code` switch: these are edge
  // and routing verdicts, and a Cloudflare challenge body carries no KyberSwap
  // `code` at all. Live-reproduced 2026-08-03: without a `User-Agent`, all
  // three hosts answer 403 `cf-mitigated: challenge` with an HTML page.
  // 451 is the status an edge returns when it blocks a whole REGION - the same
  // verdict as a 403 challenge, and it must not fall through to the generic
  // 4xx tail.
  //
  // No `externalName`: `httpStatus` already carries the status, and stamping it
  // here put an HTTP status into the KyberSwap numeric-code namespace, where a
  // 403 read downstream as "Kyber body code 403". Only a real KyberSwap body
  // code belongs in `externalName`.
  if (status === 401 || status === 403 || status === 451) {
    return withStatus(withMeta(
      new VexError(
        ErrorCodes.KYBER_API_ERROR,
        `KyberSwap refused the request (HTTP ${status}): ${message}${suffix}`,
        "The venue's edge rejected our client, not the trade. The same request will be refused the same way, so do not repeat it unchanged on this venue.",
      ),
      false,
    ), status);
  }

  if (status === 404) {
    return withStatus(withMeta(
      new VexError(
        ErrorCodes.KYBER_API_ERROR,
        `KyberSwap has no such endpoint (HTTP 404): ${message}${suffix}`,
        "The chain slug or the API path is wrong for this venue — check the chain before retrying.",
      ),
      false,
    ), status);
  }

  if (status === 429) {
    return withStatus(withMeta(
      new VexError(ErrorCodes.KYBER_RATE_LIMITED, `KyberSwap rate limit exceeded${suffix}`, "Retry with backoff."),
      true,
    ), status);
  }

  if (code !== null) {
    switch (code) {
      case 4001:
      case 4002:
        return withStatus(withMeta(
          new VexError(ErrorCodes.KYBER_MALFORMED_PARAMS, `${message}${suffix}`, "Check request parameters."),
          false, String(code),
        ), status);
      case 4005:
      case 4007:
        return withStatus(withMeta(
          new VexError(ErrorCodes.KYBER_FEE_EXCEEDS_AMOUNT, `${message}${suffix}`, "Reduce fee amount or increase swap amount."),
          false, String(code),
        ), status);
      case 4008:
      case 4010:
        return withStatus(withMeta(
          new VexError(ErrorCodes.KYBER_ROUTE_NOT_FOUND, `${message}${suffix}`, "Try different tokens, amount, or chain."),
          false, String(code),
        ), status);
      case 4009:
        return withStatus(withMeta(
          new VexError(ErrorCodes.KYBER_AMOUNT_TOO_LARGE, `${message}${suffix}`, "Reduce the swap amount."),
          false, String(code),
        ), status);
      case 4011:
        return withStatus(withMeta(
          new VexError(ErrorCodes.KYBER_TOKEN_NOT_FOUND, `${message}${suffix}`, "Verify the token address."),
          false, String(code),
        ), status);
      case 4221:
        return withStatus(withMeta(
          new VexError(ErrorCodes.KYBER_WETH_NOT_CONFIGURED, `${message}${suffix}`, "WETH is not configured on this network."),
          false, String(code),
        ), status);
    }
  }

  if (status >= 500) {
    return withStatus(withMeta(
      new VexError(ErrorCodes.KYBER_API_ERROR, `KyberSwap server error: ${message}${suffix}`, "Retry with backoff."),
      true, code != null ? String(code) : undefined,
    ), status);
  }

  return withStatus(withMeta(
    new VexError(ErrorCodes.KYBER_API_ERROR, `${message}${suffix}`),
    false, code != null ? String(code) : undefined,
  ), status);
}
