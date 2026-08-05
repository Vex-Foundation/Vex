/**
 * DexScreener error mapping.
 *
 * Maps HTTP status codes to typed VexError with DEXSCREENER_* codes, and
 * carries the provider's OWN answer — status plus a bounded, redacted excerpt
 * of whatever it sent — into the thrown error (SPEC §2.5 W2f).
 *
 * Two defects this module used to have, both live-measured (audit
 * `reports/dexscreener-virtuals.md` F3/F4):
 *
 *  - `httpStatus` was never set, so `classifyError` had no provider verdict to
 *    classify on and fell through to keyword scans over our own synthetic
 *    message. A 400 matched nothing and became `provider_error`, inviting the
 *    agent to retry a request that can never succeed; 403/429 classified
 *    correctly only because the digits happened to be in our own text.
 *  - The body was surfaced only when it was an OBJECT carrying `error`. The
 *    live 400 body is a JSON **string** (an HTML "400 Bad Request" page), so
 *    the cause was discarded and the agent read `DexScreener API returned
 *    HTTP 400` with nothing to act on.
 *
 * The remedy for an untrusted body is to SANITIZE it, not to hide it (owner
 * decree 2026-08-02, rules/04). `describeDexScreenerBody` redacts secret
 * shapes and caps the length here; the canonical summarizer
 * (`utils/error-summary`) additionally strips HTML documents, JSON bodies,
 * URLs and auth headers before anything reaches the model.
 */

import { redact } from "../../lib/diagnostics/text-redaction.js";
import { VexError, ErrorCodes } from "../../errors.js";

/**
 * Excerpt cap. Deliberately below the summarizer's 320-char message budget so
 * the status, our hint and the provider's words can coexist in one line.
 */
const MAX_BODY_EXCERPT = 200;

/**
 * Whatever the provider actually sent, reduced to one bounded, redacted line.
 *
 * Every body SHAPE is handled, because the shape is the provider's choice and
 * not a contract: a JSON string (the live 400), an object with `error` or
 * `message`, or any other JSON value. `null` means the response carried no
 * readable body at all — there is nothing to surface, and an empty string
 * would read as if the provider had said nothing when it may have said plenty.
 */
export function describeDexScreenerBody(raw: unknown): string | undefined {
  const text = bodyText(raw);
  if (text === undefined) return undefined;
  const cleaned = redact(text).text.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.length > MAX_BODY_EXCERPT
    ? `${cleaned.slice(0, MAX_BODY_EXCERPT)}…`
    : cleaned;
}

function bodyText(raw: unknown): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (typeof raw === "string") return raw;
  if (typeof raw === "object") {
    const fields = raw as Record<string, unknown>;
    for (const key of ["error", "message", "detail"] as const) {
      const value = fields[key];
      if (typeof value === "string" && value.length > 0) return value;
    }
  }
  try {
    return JSON.stringify(raw);
  } catch {
    return undefined;
  }
}

function withStatus(error: VexError, status: number): VexError {
  error.httpStatus = status;
  return error;
}

/** `HTTP <status>` always survives; the provider's words are appended when it sent any. */
function messageFor(status: number, body: unknown): string {
  const excerpt = describeDexScreenerBody(body);
  const base = `DexScreener API returned HTTP ${status}`;
  return excerpt === undefined ? base : `${base}: ${excerpt}`;
}

/**
 * @param status - HTTP status of the response that produced this error.
 * @param body - The parsed response body, in whatever shape it arrived.
 */
export function mapDexScreenerError(status: number, body?: unknown): VexError {
  const msg = messageFor(status, body);

  if (status === 429) {
    const err = new VexError(ErrorCodes.DEXSCREENER_RATE_LIMITED, msg, "Rate limit is 60 req/min for most endpoints, 300 req/min for search/pairs/tokens. Wait and retry.");
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status === 404) {
    return withStatus(new VexError(ErrorCodes.DEXSCREENER_NOT_FOUND, msg, "Check that the chain and address are correct."), status);
  }

  if (status >= 500) {
    const err = new VexError(ErrorCodes.DEXSCREENER_API_ERROR, msg, "DexScreener server error. Try again later.");
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status >= 400) {
    // A 4xx is a definitive refusal of THIS request. The hint must send the
    // agent to its own parameters, never to a retry of the same call.
    return withStatus(
      new VexError(ErrorCodes.DEXSCREENER_API_ERROR, msg, "DexScreener refused the request itself — fix the named parameters (a retry unchanged returns the same refusal)."),
      status,
    );
  }

  return withStatus(new VexError(ErrorCodes.DEXSCREENER_API_ERROR, msg), status);
}

export function mapTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("DEXSCREENER_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw new VexError(ErrorCodes.DEXSCREENER_TIMEOUT, err.message, err.hint);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw new VexError(ErrorCodes.DEXSCREENER_API_ERROR, err.message, err.hint);
  }
  throw err;
}
