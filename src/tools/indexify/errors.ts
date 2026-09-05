/**
 * Indexify error mapping — provider refusals become typed, scrubbed VexErrors.
 *
 * The provider's one error shape is `{"error": "<text>"}` with a meaningful
 * status code (400/401/403/404/409/429/503). The text is the most useful thing
 * the agent can be told ("Limit and offset must be supplied together",
 * "Insufficient balance"), so it is surfaced — but EVERY provider-origin string
 * goes through `scrubProviderText` first, the same pipeline pools.fun uses:
 * secret shapes redacted, URLs collapsed, HTML dropped, then capped. "We have
 * measured what this field contains" is not a security property, and this
 * client sends an API key with most requests.
 *
 * Status mapping, measured live 2026-08-26:
 *  - 400 `{"error": …}`          → INDEXIFY_INVALID_REQUEST (named cause)
 *  - 401 `{"error":"Unauthorized"}` / 403 → INDEXIFY_AUTH_REQUIRED
 *  - 404 JSON                    → INDEXIFY_NOT_FOUND
 *  - 404 `File not found.` (text/plain, web-server level) → the ROUTE does not
 *    exist (deanon.php is the measured case) → INDEXIFY_API_ERROR naming drift
 *  - 409                         → INDEXIFY_INVALID_REQUEST (conflict, named)
 *  - 429 / 503                   → INDEXIFY_RATE_LIMITED (leaky bucket, 10 rps)
 *  - everything else             → INDEXIFY_API_ERROR
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";
import { scrubProviderText } from "../../utils/error-summary.js";

/** Max length of provider text carried into an error message. */
const MAX_PROVIDER_TEXT = 200;

/** Extract and scrub the provider's own `error` string, when the body is its JSON shape. */
function providerErrorText(bodyText: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (isRecord(parsed) && typeof parsed.error === "string" && parsed.error.length > 0) {
      return scrubProviderText(parsed.error, MAX_PROVIDER_TEXT);
    }
  } catch {
    // Non-JSON body — fall through to the snippet path.
  }
  return undefined;
}

/** Map a non-ok HTTP response to a typed VexError. Always throws. */
export function mapIndexifyHttpError(status: number, bodyText: string): never {
  const detail = providerErrorText(bodyText);

  if (status === 401 || status === 403) {
    throw withStatus(new VexError(
      ErrorCodes.INDEXIFY_AUTH_REQUIRED,
      `Indexify refused the request (HTTP ${status}${detail ? `: ${detail}` : ""})`,
      "This Indexify action needs a valid INDEXIFY_API_KEY for the linked account.",
    ), status);
  }
  if (status === 404) {
    if (detail === undefined) {
      // Web-server-level "File not found." — the route itself is gone/undeployed.
      throw withStatus(new VexError(
        ErrorCodes.INDEXIFY_API_ERROR,
        `Indexify route missing (HTTP 404, non-JSON body) — the provider's API surface drifted`,
        "Indexify no longer serves this endpoint.",
      ), status);
    }
    throw withStatus(new VexError(
      ErrorCodes.INDEXIFY_NOT_FOUND,
      `Indexify: not found (${detail})`,
      "Indexify does not know that stack, token, order, or user.",
    ), status);
  }
  if (status === 429 || status === 503) {
    throw withStatus(new VexError(
      ErrorCodes.INDEXIFY_RATE_LIMITED,
      `Indexify rate limit (HTTP ${status}${detail ? `: ${detail}` : ""})`,
      "Indexify is rate limiting (10 req/s, burst 100). Wait briefly and retry.",
    ), status);
  }
  if (status === 400 || status === 409) {
    throw withStatus(new VexError(
      ErrorCodes.INDEXIFY_INVALID_REQUEST,
      `Indexify rejected the request (HTTP ${status}${detail ? `: ${detail}` : ""})`,
      detail ?? "Indexify rejected the request parameters.",
    ), status);
  }
  throw withStatus(new VexError(
    ErrorCodes.INDEXIFY_API_ERROR,
    `Indexify API error (HTTP ${status}${detail ? `: ${detail}` : ""})`,
    "Indexify answered with a server-side failure.",
  ), status);
}

/** Re-tag transport failures (timeout/abort/DNS) once, at the boundary. Always throws. */
export function mapIndexifyTransportError(err: unknown): never {
  if (err instanceof VexError) throw err;
  if (err instanceof Error && err.name === "AbortError") {
    throw new VexError(
      ErrorCodes.INDEXIFY_TIMEOUT,
      "Indexify request timed out or was aborted",
      "Indexify did not answer in time.",
    );
  }
  const reason = err instanceof Error ? err.constructor.name : typeof err;
  throw new VexError(
    ErrorCodes.INDEXIFY_API_ERROR,
    `Indexify request failed before a response arrived (${reason})`,
    "Could not reach the Indexify API.",
  );
}

function withStatus(error: VexError, status: number): VexError {
  error.httpStatus = status;
  return error;
}
