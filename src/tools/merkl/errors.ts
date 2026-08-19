/**
 * Error mapping for the Merkl client, in the format required by
 * `agents_dm/tool-audit-2026-08/RULES-DRAFT.md` (a):
 *
 *   <toolId> failed [<CODE>/<category>, HTTP <status>]: <sanitized cause> - <remediation>
 *
 * The three properties that rule makes non-negotiable, applied here:
 *
 *  1. CLASSIFICATION READS `httpStatus` FIRST, never a keyword scan over text.
 *  2. THE PROVIDER'S BODY IS CARRIED, sanitized, never dropped. Merkl publishes a
 *     precise problem+json vocabulary and it is the whole value of the failure:
 *     a live 400 for a missing `chainId` answered
 *     `{"type":"/errors/validation","title":"Validation Error","status":400,
 *     "detail":"Validation failed","instance":"/v4/users/0x.../rewards",
 *     "errors":{...}}` and a bad route answered
 *     `{"type":"/errors/not-found","title":"Not Found",...}`. Reducing either to
 *     "HTTP 400" throws away the only sentence that says what to change.
 *  3. NO FIXED SENTENCE OVERWRITES THE PROVIDER'S WORDS. Remediation is appended.
 *
 * Merkl's limit is generous (4,200/minute, published on every response), so a 429
 * here means our own fan-out misbehaved rather than that the provider is scarce.
 * The remediation says so, because "wait and retry" would be the wrong lesson.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";

const MAX_CAUSE_LENGTH = 400;
const LONG_HEX = /0x[0-9a-fA-F]{16,}/g;
const URL_PATTERN = /https?:\/\/\S+/g;
const BEARER_PATTERN = /\b(?:bearer|token|api[_-]?key)\s*[:=]\s*\S+/gi;

/**
 * Sanitize an upstream string for an agent-facing message. Sanitize, do NOT
 * hide: URLs, long hex blobs and auth-shaped fragments go, every other word
 * Merkl wrote survives.
 */
export function sanitizeMerklCause(text: string): string {
  const scrubbed = text
    .replace(URL_PATTERN, "[url]")
    .replace(BEARER_PATTERN, "[redacted]")
    .replace(LONG_HEX, "[hex]")
    .replace(/\s+/g, " ")
    .trim();
  if (scrubbed.length <= MAX_CAUSE_LENGTH) return scrubbed;
  return `${scrubbed.slice(0, MAX_CAUSE_LENGTH)} [truncated]`;
}

/**
 * Pull the readable cause out of whatever arrived.
 *
 * Merkl's problem+json puts the machine-readable `type` first so it survives the
 * length cap, then the human `title` and `detail`. A body that is not JSON, is a
 * bare string, or is missing the fields this parser expected is STILL EVIDENCE
 * and is surfaced as it arrived.
 */
export function readMerklErrorMessage(body: unknown): string {
  if (typeof body === "string") return sanitizeMerklCause(body);
  if (!isRecord(body)) return "";

  const parts: string[] = [];
  for (const key of ["type", "title", "detail"]) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) parts.push(value);
  }
  if (parts.length === 0) {
    for (const key of ["message", "error"]) {
      const value = body[key];
      if (typeof value === "string" && value.length > 0) parts.push(value);
    }
  }
  const errors = body["errors"];
  if (isRecord(errors) || Array.isArray(errors)) parts.push(JSON.stringify(errors));
  return parts.length > 0 ? sanitizeMerklCause(parts.join(" - ")) : "";
}

function withCause(base: string, cause: string): string {
  return cause.length > 0 ? `${base}: ${cause}` : `${base}.`;
}

/**
 * Map an HTTP status from Merkl to a coded error carrying the status, the
 * sanitized provider cause, and a remediation.
 */
export function mapMerklHttpError(status: number, body: unknown, retryAfterSeconds?: number): VexError {
  const cause = readMerklErrorMessage(body);
  const err = buildHttpError(status, cause, retryAfterSeconds);
  err.httpStatus = status;
  err.retryable = status === 429 || status >= 500;
  if (retryAfterSeconds !== undefined) err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

function buildHttpError(status: number, cause: string, retryAfterSeconds: number | undefined): VexError {
  if (status === 429) {
    return new VexError(
      ErrorCodes.MERKL_RATE_LIMITED,
      withCause("Merkl rate limited the request (HTTP 429)", cause),
      "Merkl publishes roughly 4,200 requests a minute and reports the remainder on every response, "
      + "so a 429 means Vex's own fan-out ran hot rather than that Merkl is scarce. "
      + (retryAfterSeconds !== undefined
        ? `Merkl asked for a ${retryAfterSeconds}-second pause. `
        : "Merkl named no interval. ")
      + "Narrow the chain list rather than repeating the same wide sweep.",
    );
  }
  if (status === 400) {
    return new VexError(
      ErrorCodes.MERKL_API_ERROR,
      withCause("Merkl rejected the request (HTTP 400)", cause),
      "Merkl names the offending query field above. Fix that field - retrying unchanged returns the same refusal. "
      + "A rewards read always needs exactly one chain per request.",
    );
  }
  if (status === 404) {
    return new VexError(
      ErrorCodes.MERKL_API_ERROR,
      withCause("Merkl answered HTTP 404", cause),
      "The route does not exist rather than the data being absent - a wallet with no rewards answers HTTP 200 "
      + "with an empty list. This needs a code fix, not a retry.",
    );
  }
  if (status >= 500) {
    return new VexError(
      ErrorCodes.MERKL_API_ERROR,
      withCause(`Merkl server error (HTTP ${status})`, cause),
      "Merkl publishes no SLA. Try later, and report unclaimed rewards as unknown rather than as zero.",
    );
  }
  return new VexError(
    ErrorCodes.MERKL_API_ERROR,
    withCause(`Merkl returned HTTP ${status}`, cause),
    "Report the status and the cause above rather than retrying blind.",
  );
}

/**
 * Normalize a transport-layer throw. Never INVENTS an `httpStatus`: nothing
 * answered, so there is no status, and inventing one erases the difference
 * between "Merkl refused" and "we could not reach Merkl".
 */
export function mapMerklTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("MERKL_")) throw err;
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw carryStatus(new VexError(ErrorCodes.MERKL_TIMEOUT, err.message, err.hint), err);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw carryStatus(new VexError(ErrorCodes.MERKL_API_ERROR, err.message, err.hint), err);
  }
  throw err;
}

function carryStatus(error: VexError, original: VexError): VexError {
  error.retryable = true;
  if (original.httpStatus !== undefined) error.httpStatus = original.httpStatus;
  error.cause = original;
  return error;
}
