/**
 * Error mapping for the Morpho GraphQL client.
 *
 * Format, per `agents_dm/tool-audit-2026-08/RULES-DRAFT.md` (a):
 *
 *   <toolId> failed [<CODE>/<category>, HTTP <status>]: <sanitized cause> - <remediation>
 *
 * The client's half is the code, the status and the sanitized cause; the handler
 * layer prefixes the toolId. Three properties are non-negotiable and each has a
 * named live failure behind it:
 *
 *  1. CLASSIFICATION READS `httpStatus` FIRST. A body message legitimately
 *     replaces the status line, so a keyword scan over text cannot see a 403
 *     whose body says "quota exceeded".
 *  2. THE PROVIDER'S BODY IS CARRIED, sanitized, never dropped. GraphQL is the
 *     sharpest case in the tree: Morpho answers a bad field with HTTP 200 and a
 *     precise `errors[].message` ("Cannot query field \"whitelisted\" on type
 *     \"Market\". Did you mean \"listed\"?"). Discarding that leaves the agent
 *     with a bare status that says nothing at all.
 *  3. NO FIXED SENTENCE OVERWRITES THE PROVIDER'S WORDS. A remediation is
 *     appended; it never replaces the cause.
 *
 * A 429 is the expensive one here. Morpho's documented abuse response is
 * `Retry-After: 604800` - a SEVEN-DAY ban. The remediation says so in days
 * rather than seconds, because "retry after 604800" reads as a transient hint
 * and would invite exactly the retry loop that earned the ban.
 */

import { VexError, ErrorCodes } from "../../errors.js";
import { isRecord } from "../../utils/validation-helpers.js";

/** Long hex blobs and URLs are stripped; the readable cause is kept. */
const MAX_CAUSE_LENGTH = 400;
const LONG_HEX = /0x[0-9a-fA-F]{16,}/g;
const URL_PATTERN = /https?:\/\/\S+/g;
const BEARER_PATTERN = /\b(?:bearer|token|api[_-]?key)\s*[:=]\s*\S+/gi;

/**
 * Sanitize an upstream string for an agent-facing message.
 *
 * Sanitize, do NOT hide (rules/04). URLs, long hex blobs and auth-shaped
 * fragments are removed because they are noise or hazard; every other word the
 * provider wrote survives, because those words are the reason the call failed.
 */
export function sanitizeMorphoCause(text: string): string {
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
 * A body that is not JSON, is a bare string, or is JSON missing the field a
 * parser expected is STILL EVIDENCE - each shape is handled rather than dropped.
 */
export function readMorphoErrorMessage(body: unknown): string {
  if (typeof body === "string") return sanitizeMorphoCause(body);
  if (!isRecord(body)) return "";

  const errors = body["errors"];
  if (Array.isArray(errors)) {
    const messages = errors
      .map((entry) => (isRecord(entry) && typeof entry["message"] === "string" ? entry["message"] : null))
      .filter((message): message is string => message !== null);
    if (messages.length > 0) return sanitizeMorphoCause(messages.join("; "));
  }
  for (const key of ["message", "error", "detail"]) {
    const value = body[key];
    if (typeof value === "string" && value.length > 0) return sanitizeMorphoCause(value);
  }
  return "";
}

/** `"<base>: <cause>."` when the provider spoke, `"<base>."` when it did not. */
function withCause(base: string, cause: string): string {
  return cause.length > 0 ? `${base}: ${cause}` : `${base}.`;
}

/** Whole days, rounded up, for a ban-length remediation a human can read. */
function describeRetryAfter(seconds: number | undefined): string {
  if (seconds === undefined) return "Morpho named no retry interval.";
  if (seconds >= 86_400) {
    const days = Math.ceil(seconds / 86_400);
    return `Morpho asked for a ${days}-day wait - that is its ABUSE penalty, not a transient backoff. `
      + "Do not retry inside that window; report it and use another data source meanwhile.";
  }
  return `Morpho asked for a ${seconds}-second wait before the next request.`;
}

/**
 * Map an HTTP status from Morpho to a coded error carrying the status, the
 * sanitized provider cause, and a remediation.
 */
export function mapMorphoHttpError(status: number, body: unknown, retryAfterSeconds?: number): VexError {
  const cause = readMorphoErrorMessage(body);
  const err = buildHttpError(status, cause, retryAfterSeconds);
  err.httpStatus = status;
  // Only a rate limit and a server fault can succeed unchanged on a retry. Any
  // other 4xx is Morpho's verdict on the request itself.
  err.retryable = status === 429 || status >= 500;
  if (retryAfterSeconds !== undefined) err.retryAfterSeconds = retryAfterSeconds;
  return err;
}

function buildHttpError(status: number, cause: string, retryAfterSeconds: number | undefined): VexError {
  if (status === 429) {
    return new VexError(
      ErrorCodes.MORPHO_RATE_LIMITED,
      withCause("Morpho rate limited the request (HTTP 429)", cause),
      `Morpho's keyless GraphQL API allows roughly 750 requests per minute and answers sustained abuse `
      + `with a week-long block. ${describeRetryAfter(retryAfterSeconds)}`,
    );
  }
  if (status === 400) {
    return new VexError(
      ErrorCodes.MORPHO_API_ERROR,
      withCause("Morpho rejected the query (HTTP 400)", cause),
      "Morpho names the offending field above when it can. Fix that field - retrying unchanged returns the same refusal.",
    );
  }
  if (status === 403) {
    return new VexError(
      ErrorCodes.MORPHO_API_ERROR,
      withCause("Morpho forbade the request (HTTP 403)", cause),
      "Morpho's edge denied this client; the query parameters are not the problem. Do not retry unchanged - report it.",
    );
  }
  if (status === 404) {
    return new VexError(
      ErrorCodes.MORPHO_API_ERROR,
      withCause("Morpho's GraphQL endpoint answered HTTP 404", cause),
      "The configured `services.morphoApiUrl` may be wrong or the endpoint may have moved. Report it - a retry cannot fix a route.",
    );
  }
  if (status >= 500) {
    return new VexError(
      ErrorCodes.MORPHO_API_ERROR,
      withCause(`Morpho server error (HTTP ${status})`, cause),
      "Morpho publishes no SLA. Try again later, and never treat a Morpho read as a hard dependency of a money path.",
    );
  }
  return new VexError(
    ErrorCodes.MORPHO_API_ERROR,
    withCause(`Morpho returned HTTP ${status}`, cause),
    "Report the status and the cause above rather than retrying blind.",
  );
}

/**
 * GraphQL's own failure mode: HTTP 200 with a populated `errors` array. Losing
 * this would turn every schema drift into a silent empty result.
 */
export function mapMorphoGraphqlError(cause: string): VexError {
  const err = new VexError(
    ErrorCodes.MORPHO_API_ERROR,
    withCause("Morpho rejected the GraphQL query (HTTP 200 with errors)", sanitizeMorphoCause(cause)),
    "Morpho names the field it could not resolve. Its schema deprecates and REMOVES fields on a live schedule, "
    + "so a field that worked before can be gone - this needs a code fix, not a retry.",
  );
  err.httpStatus = 200;
  err.retryable = false;
  return err;
}

/**
 * Normalize a transport-layer throw.
 *
 * Never INVENTS an `httpStatus`: nothing answered, so there is no status, and
 * inventing one erases the distinction between "Morpho refused" and "we could
 * not reach Morpho". It does CARRY one the wrapped error already observed.
 */
export function mapMorphoTransportError(err: unknown): never {
  if (err instanceof VexError && err.code.startsWith("MORPHO_")) throw err;
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_TIMEOUT) {
    throw carryStatus(new VexError(ErrorCodes.MORPHO_TIMEOUT, err.message, err.hint), err);
  }
  if (err instanceof VexError && err.code === ErrorCodes.HTTP_REQUEST_FAILED) {
    throw carryStatus(new VexError(ErrorCodes.MORPHO_API_ERROR, err.message, err.hint), err);
  }
  throw err;
}

function carryStatus(error: VexError, original: VexError): VexError {
  error.retryable = true;
  if (original.httpStatus !== undefined) error.httpStatus = original.httpStatus;
  error.cause = original;
  return error;
}
