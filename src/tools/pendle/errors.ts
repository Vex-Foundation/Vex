/**
 * Pendle API error mapping.
 *
 * ── DOCTRINE CHANGE (W2e, owner decree 2026-08-02) ────────────────────────
 * The WAVE-3 rule here used to be "the upstream body is HOSTILE input, so no
 * upstream text may reach the thrown message". That produced the exact failure
 * the decree forbids: a Pendle validation 400 whose body says
 * `{"message":["timeFrame must be either hour, day or week"],…}` reached the
 * agent as *"Pendle rejected the request."* — no status, no field, no cause, so
 * the agent retried blind and paid for the same refusal again.
 *
 * The rule is now the fleet rule (see `tools/kyberswap/errors.ts`): the
 * provider's own words are CARRIED, bounded, and SANITIZED downstream by the
 * single owner of redaction — `utils/error-summary.ts`'s
 * `summarizeProtocolError`, which every Pendle handler already routes its
 * failures through (`handlers/shared.ts` `failureDetail`). Secrets are
 * scrubbed, not hidden. This module bounds the copied text (a body is
 * untrusted in LENGTH as well as content) and never re-emits it as anything
 * but a quoted cause.
 *
 * `httpStatus` is stamped on EVERY error produced here: it is the field the
 * error contract classifies on before it reads any prose, and dropping it makes
 * a definitive 4xx refusal indistinguishable from a transport failure.
 *
 * Known 400 bodies (live-probed 2026-07-05 / 2026-08-03):
 *   - "The input valuation is too low. The minimum valuation is …"  → too-low
 *   - "The input valuation is too high. The maximum valuation is …" → too-high
 *   - "… token … in list …" / "token not found"                    → token
 *   - "Unable to classify convert action" (NO `error` field)        → expired-buy
 *   - `{"message":[ …NestJS validation strings… ]}`                → array shape
 */

import { VexError, ErrorCodes } from "../../errors.js";

/**
 * Length cap on the provider text we quote. The scrubber caps the FINAL
 * agent-facing message; this cap keeps an unbounded body from being built into
 * an error string in the first place.
 */
const MAX_PENDLE_CAUSE = 200;

/**
 * The provider's own words from a non-ok Pendle body, in every shape Pendle
 * actually sends.
 *
 * NestJS — which Pendle's hosted API runs — reports validation failures as an
 * ARRAY of field sentences (`{"message":["timeFrame must be either hour, day
 * or week"]}`). Reading `message` only when it is a string dropped the entire
 * class: every parameter-level 400 collapsed to a generic sentence. The array
 * JOINS, so the agent is told each field that was rejected.
 */
export function readPendleErrorMessage(body: unknown): string {
  if (body === null || typeof body !== "object") return "";
  const record = body as { message?: unknown; error?: unknown };
  const text = joinMessage(record.message) || joinMessage(record.error);
  return text.length > MAX_PENDLE_CAUSE ? `${text.slice(0, MAX_PENDLE_CAUSE)}…` : text;
}

function joinMessage(raw: unknown): string {
  if (typeof raw === "string") return raw.trim();
  if (Array.isArray(raw)) {
    return raw
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .map((entry) => entry.trim())
      .join("; ");
  }
  return "";
}

/** `"<base>: <cause>"`, or just `<base>` when the provider said nothing. */
function withCause(base: string, cause: string): string {
  return cause.length > 0 ? `${base}: ${cause}` : base;
}

/** Stamp the status the provider answered with. Never invented — see the header. */
function withStatus(error: VexError, status: number): VexError {
  error.httpStatus = status;
  return error;
}

/** Narrow the untrusted 400 body to a fixed code, quoting the provider's cause. */
function classifyBadRequest(body: unknown): VexError {
  const cause = readPendleErrorMessage(body);
  const message = cause.toLowerCase();

  if (message.includes("valuation is too low") || message.includes("minimum valuation")) {
    return new VexError(
      ErrorCodes.PENDLE_VALUATION_TOO_LOW,
      withCause("Pendle rejected the amount: below the minimum trade size (about $0.01)", cause),
      "Increase the amount and retry.",
    );
  }
  if (message.includes("valuation is too high") || message.includes("maximum valuation")) {
    return new VexError(
      ErrorCodes.PENDLE_VALUATION_TOO_HIGH,
      withCause("Pendle rejected the amount: above the maximum trade size ($100M)", cause),
      "Reduce the amount and retry.",
    );
  }
  if (message.includes("classify convert action")) {
    return new VexError(
      ErrorCodes.PENDLE_MARKET_EXPIRED,
      withCause(
        "Pendle could not build this trade — the market has likely expired (a matured PT can only be redeemed, not bought/sold)",
        cause,
      ),
      "For a matured PT use pendle.pt.redeem; otherwise re-check the market with pendle.yields.",
    );
  }
  if (message.includes("token") && (message.includes("list") || message.includes("not found"))) {
    return new VexError(
      ErrorCodes.PENDLE_TOKEN_NOT_FOUND,
      withCause("Pendle does not recognize one of the tokens for this route", cause),
      "Verify the PT / payment-token addresses with pendle.yields, then retry.",
    );
  }
  return new VexError(
    ErrorCodes.PENDLE_API_ERROR,
    withCause("Pendle rejected the request (HTTP 400)", cause),
    "Pendle names the rejected parameter above when it can. Fix that parameter — retrying it unchanged returns the same refusal.",
  );
}

/**
 * Map an HTTP status (+ the untrusted body) to a fixed, code-keyed VexError
 * carrying the provider's own cause and the answering status.
 */
export function mapPendleError(status: number, body?: unknown): VexError {
  const err = buildPendleError(status, body);
  return withStatus(err, status);
}

function buildPendleError(status: number, body: unknown): VexError {
  const cause = readPendleErrorMessage(body);

  if (status === 429) {
    const err = new VexError(
      ErrorCodes.PENDLE_RATE_LIMITED,
      withCause("Pendle API rate limited (HTTP 429)", cause),
      "Pendle is self-throttled by compute units. Wait and retry.",
    );
    err.retryable = true;
    return err;
  }
  if (status === 400) {
    return classifyBadRequest(body);
  }
  // 401/402/403/409/422 used to collapse to a bare `HTTP n` with no hint at
  // all. Each is a DIFFERENT next action, and Pendle now sells API keys, so
  // the auth/payment pair is live rather than theoretical.
  if (status === 401) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause("Pendle refused the request as unauthenticated (HTTP 401)", cause),
      "This Pendle endpoint now requires an API key and Vex has none configured for it. Retrying cannot succeed — report it and use another source for this data.",
    );
  }
  if (status === 402) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause("Pendle refused the request pending payment (HTTP 402)", cause),
      "The Pendle API plan behind this endpoint is out of quota or unpaid. Retrying cannot succeed — report it and use another source for this data.",
    );
  }
  if (status === 403) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause("Pendle forbade the request (HTTP 403)", cause),
      "Pendle's edge or plan denies this endpoint to Vex's client — the trade parameters are not the problem. Do not retry unchanged; report it.",
    );
  }
  if (status === 404) {
    return new VexError(
      ErrorCodes.PENDLE_TOKEN_NOT_FOUND,
      withCause("Pendle resource not found (HTTP 404)", cause),
      "Verify the market / token / wallet and retry.",
    );
  }
  if (status === 409) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause("Pendle reports a conflicting state (HTTP 409)", cause),
      "The market or order state moved while this request was in flight. Re-read the market with pendle.yields and build a FRESH quote — do not replay the old one.",
    );
  }
  if (status === 422) {
    return new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause("Pendle rejected the request parameters (HTTP 422)", cause),
      "A parameter is well-formed but not acceptable to Pendle. Fix the parameter Pendle names above — retrying it unchanged returns the same refusal.",
    );
  }
  if (status >= 500) {
    const err = new VexError(
      ErrorCodes.PENDLE_API_ERROR,
      withCause(`Pendle server error (HTTP ${status})`, cause),
      "Pendle server error. Try again later.",
    );
    err.retryable = true;
    return err;
  }
  return new VexError(ErrorCodes.PENDLE_API_ERROR, withCause(`Pendle API returned HTTP ${status}`, cause));
}

/**
 * The provider answered, but not in a shape we can read. This is deliberately a
 * THROW and not a degraded empty result: "Pendle says the collection is empty"
 * and "Pendle sent something I cannot parse" are different facts, and conflating
 * them is what let `/v1/assets/all` return `[]` on every call for months — every
 * token silently 18-decimal, every cost basis $0, every PT invisible in the
 * portfolio, with nothing logged.
 *
 * `detail` MUST come from our own static vocabulary — this is OUR parser's
 * verdict on the body, not the body's own words.
 */
export function pendleInvalidResponse(endpoint: string, detail: string): VexError {
  return new VexError(
    ErrorCodes.PENDLE_INVALID_RESPONSE,
    `Pendle returned an unreadable ${endpoint} response (${detail}).`,
    "Pendle changed a response shape Vex depends on. This is a provider-side fault; "
    + "retrying with different parameters will not help. Use another source for this data.",
  );
}

/**
 * Normalize a transport-layer throw into a Pendle-coded VexError.
 *
 * `httpStatus` is CARRIED OVER when the wrapped error had one: re-wrapping used
 * to destroy the only field that distinguishes a definitive provider refusal
 * from an ambiguous transport failure.
 */
export function mapPendleTransportError(err: unknown): never {
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

/** Stamp a status we are carrying over from an error we re-wrapped. */
function carryStatus(error: VexError, status: number | undefined): VexError {
  if (status !== undefined) error.httpStatus = status;
  return error;
}
