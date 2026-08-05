/**
 * Virtuals Protocol error mapping.
 *
 * Maps HTTP status codes to typed VexError with VIRTUALS_* codes, mirroring the
 * DexScreener error module — including its posture on the upstream body.
 *
 * THE POLICY THIS MODULE USED TO STATE, AND WHY IT IS GONE (SPEC §2.6 W2f).
 * The old header declared that upstream text is hostile input and therefore
 * "NEVER copies upstream text into the error message". The Virtuals API is
 * indeed unauthenticated and undocumented — but hiding is the wrong remedy and
 * contradicts the owner decree of 2026-08-02 (rules/04): a failed tool call
 * states what actually happened, SANITIZED, never silenced. The measured cost
 * of hiding was that a Virtuals 403 edge challenge, a 400 missing-chain-filter
 * and any other 4xx arrived at the agent as three indistinguishable fixed
 * sentences, so it could not tell a fixable request from an unfixable one.
 *
 * `describeVirtualsBody` redacts secret shapes and caps the excerpt here; the
 * canonical summarizer (`utils/error-summary`) additionally strips HTML
 * documents, JSON bodies, URLs and auth headers before anything reaches the
 * model. What sanitization cannot neutralise is instruction-shaped prose, and
 * the mitigation for that is the Safety Contract — which teaches the model that
 * tool output is data, never instruction — not a blank error.
 *
 * `httpStatus` is stamped on every mapped error so `classifyError` sees the
 * provider's verdict instead of guessing from our own prose.
 */

import { redact } from "../../lib/diagnostics/text-redaction.js";
import { VexError, ErrorCodes } from "../../errors.js";

/** Below the summarizer's 320-char budget, so status + hint + body coexist. */
const MAX_BODY_EXCERPT = 200;

/**
 * Whatever the provider actually sent, reduced to one bounded, redacted line.
 * Strapi answers with `{ error: { message } }` on a rejection and an HTML page
 * from the edge, so no single shape can be assumed.
 */
export function describeVirtualsBody(raw: unknown): string | undefined {
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
    // Strapi nests the human sentence one level down under `error`.
    const nested = fields.error;
    if (nested !== null && typeof nested === "object") {
      const message = (nested as Record<string, unknown>).message;
      if (typeof message === "string" && message.length > 0) return message;
    }
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

/** Our own sentence first (it names the remedy), the provider's words appended. */
function withBody(sentence: string, body: unknown): string {
  const excerpt = describeVirtualsBody(body);
  return excerpt === undefined ? sentence : `${sentence} Upstream said: ${excerpt}`;
}

/**
 * @param status - HTTP status of the response that produced this error.
 * @param body - The parsed response body, in whatever shape it arrived.
 */
export function mapVirtualsError(status: number, body?: unknown): VexError {
  if (status === 429) {
    const err = new VexError(
      ErrorCodes.VIRTUALS_RATE_LIMITED,
      withBody("Virtuals API rate limited (HTTP 429).", body),
      "Virtuals API is unauthenticated and self-throttled. Wait and retry.",
    );
    err.retryable = true;
    return withStatus(err, status);
  }

  if (status === 404) {
    return withStatus(new VexError(
      ErrorCodes.VIRTUALS_NOT_FOUND,
      withBody("Virtuals agent not found (HTTP 404).", body),
      "Check that the Virtuals agent id is correct.",
    ), status);
  }

  if (status === 400) {
    return withStatus(new VexError(
      ErrorCodes.VIRTUALS_API_ERROR,
      withBody("Virtuals API rejected the request (HTTP 400).", body),
      "The list endpoint requires a chain filter — call listVirtuals with a chain.",
    ), status);
  }

  if (status >= 500) {
    const err = new VexError(
      ErrorCodes.VIRTUALS_API_ERROR,
      withBody(`Virtuals server error (HTTP ${status}).`, body),
      "Virtuals server error. Try again later.",
    );
    err.retryable = true;
    return withStatus(err, status);
  }

  return withStatus(new VexError(
    ErrorCodes.VIRTUALS_API_ERROR,
    withBody(`Virtuals API returned HTTP ${status}.`, body),
  ), status);
}

export function mapVirtualsTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("VIRTUALS_")) {
    throw err;
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw new VexError(ErrorCodes.VIRTUALS_TIMEOUT, err.message, err.hint);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw new VexError(ErrorCodes.VIRTUALS_API_ERROR, err.message, err.hint);
  }
  throw err;
}
