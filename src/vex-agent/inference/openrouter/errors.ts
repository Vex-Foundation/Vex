/**
 * OpenRouter error normalization — REDACTED + status-preserving.
 *
 * Raw SDK errors are dangerous to surface verbatim. `OpenRouterError`
 * (the SDK base) carries `body` (raw HTTP body), `headers`, and `rawResponse`;
 * the typed subclasses additionally carry `error.metadata` (provider
 * raw/reason/details — may contain request bodies, URLs, prompt content),
 * `openrouterMetadata`, and `userId` (PII). NONE of those may reach a log line
 * or an `Error.message` that bubbles up.
 *
 * This normalizer therefore emits ONLY:
 *   - `statusCode` (authoritative HTTP status; numeric, not secret),
 *   - `error.code`  (numeric provider error code, not secret),
 *   - a BOUNDED, SCRUBBED message (provider message run through the canonical
 *     secret/PII redactor + URL scrub + length cap).
 * The whole error object is NEVER serialized.
 *
 * It also attaches the status as a LEAN OWN-PROPERTY (`statusCode` + `status`)
 * on the returned Error so `mission-error-classifier.ts` can read it directly
 * and classify transient 429/5xx for auto-retry. The status lives on a plain
 * own-property (NOT `.cause`) precisely so no serializer can walk it back into
 * the raw body/headers/PII the SDK error held.
 *
 * The SDK-depth phase adds one more own-property in the same lean idiom:
 * `errorType`, OpenRouter's canonical `ApiErrorType` off a mid-stream error
 * chunk (see `attachErrorType`). Its sibling `providerCode` is deliberately
 * NOT carried — free-form provider text.
 *
 * Error-diagnostics phase (D-RUNTIME): the errno-shaped cause code extracted
 * from the ORIGINAL caught error's `.cause` chain rides along the same way —
 * a lean `causeCode` own-property (a closed-dictionary string, never message
 * text). The normalized error still NEVER gets a `.cause`: linking the raw
 * SDK error (or any object) back onto it would re-open the exact re-leak
 * path this normalizer exists to close.
 */

import { OpenRouterError } from "../../../lib/openrouter-client.js";
import { extractCauseCode } from "../../../lib/error-cause.js";
import { redact } from "../../../lib/diagnostics/text-redaction.js";
import { boundedErrorClass, OPENROUTER_ERROR_CLASSES } from "./error-class.js";
import { boundedErrorType } from "./provider-signals.js";
import { retryAfterSecondsFromError } from "./retry-after.js";

/** Max characters of a scrubbed provider message kept in the normalized error. */
const MAX_MESSAGE_LEN = 300;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** URLs (incl. paths/query) are not secrets per se but can embed tokens/PII. */
const URL_RE = /\bhttps?:\/\/[^\s'"]+/gi;
/** `Authorization: Bearer <token>` style values (redactor covers sk-* keys). */
const BEARER_RE = /\bBearer\s+[a-zA-Z0-9._-]+/gi;

/**
 * Scrub a free-text provider message down to something safe to log/surface:
 * hard-redact secrets/keys/JWT/PII via the canonical redactor, strip URLs and
 * bearer tokens, collapse whitespace, then cap the length. Returns `null` for
 * empty/whitespace input so callers can fall through to a generic message.
 */
export function scrubMessage(raw: string): string | null {
  if (raw.trim().length === 0) return null;
  let out = redact(raw).text;
  out = out.replace(BEARER_RE, "[REDACTED:bearer]");
  out = out.replace(URL_RE, "[url]");
  out = out.replace(/\s+/g, " ").trim();
  if (out.length === 0) return null;
  return out.length > MAX_MESSAGE_LEN ? `${out.slice(0, MAX_MESSAGE_LEN)}...` : out;
}

/**
 * Extract the numeric provider error code WITHOUT keeping any message/metadata.
 * Prefers the typed-subclass `error.code`; falls back to parsing only the
 * `code` field out of a JSON `body`. The body string itself is never returned.
 */
function extractErrorCode(err: Record<string, unknown>): number | null {
  if (isRecord(err.error)) {
    const code = asFiniteNumber(err.error.code);
    if (code !== null) return code;
  }
  if (typeof err.body === "string" && err.body.trim().length > 0) {
    try {
      const parsed: unknown = JSON.parse(err.body);
      if (isRecord(parsed) && isRecord(parsed.error)) {
        return asFiniteNumber(parsed.error.code);
      }
    } catch {
      // Non-JSON body — no code to extract; never surface the raw body.
    }
  }
  return null;
}

/** Pull the provider-supplied message (typed subclass `error.message`) if present. */
function extractProviderMessage(err: Record<string, unknown>): string | null {
  if (isRecord(err.error)) {
    return asNonEmptyString(err.error.message);
  }
  return null;
}

/**
 * Attach an HTTP status to an Error as LEAN, NON-ENUMERABLE own-properties
 * (`statusCode` + `status`) so the mission classifier reads it directly. Plain
 * numbers only — no `.cause` (a serializer following `.cause` could re-leak raw
 * body/headers/PII), and no reference back to any original SDK error. No-op for
 * a non-finite status. Returns the same Error for chaining.
 */
export function attachStatus(target: Error, status: number | null | undefined): Error {
  if (typeof status !== "number" || !Number.isFinite(status)) return target;
  Object.defineProperty(target, "statusCode", {
    value: status,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  Object.defineProperty(target, "status", {
    value: status,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

/**
 * Attach an errno-shaped cause code (output of `extractCauseCode`) as a LEAN,
 * NON-ENUMERABLE own-property (`causeCode`) — same idiom as `attachStatus`.
 * A plain string only — explicitly NOT `.cause` (a serializer following
 * `.cause` could re-leak the raw SDK error's body/headers/PII), and never a
 * reference to any original error object. No-op for `null`. Returns the same
 * Error for chaining.
 */
export function attachCauseCode(target: Error, causeCode: string | null): Error {
  if (causeCode === null) return target;
  Object.defineProperty(target, "causeCode", {
    value: causeCode,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

/**
 * Attach OpenRouter's canonical error type (`ApiErrorType`, from a mid-stream
 * error chunk's `error.metadata.errorType`) as a LEAN, NON-ENUMERABLE
 * own-property — same idiom as `attachStatus` / `attachCauseCode`, and for the
 * same reason: explicitly NOT `.cause`, so no serializer can walk back to the
 * raw body/headers/PII.
 *
 * `ApiErrorType` is an OPEN enum in the installed SDK, so the value is carried
 * VERBATIM rather than mapped onto a closed set — any consumer that switches on
 * it needs a total default branch. Mapping bounded error categories for the UI
 * is deliberately NOT done here (that is the error-channel work, Wave 2).
 *
 * The sibling `metadata.providerCode` is NOT attached anywhere: it is free-form
 * upstream provider text with no bounded vocabulary, which is exactly the kind
 * of value this module exists to keep out of logs. No-op for `null`.
 */
export function attachErrorType(target: Error, errorType: string | null): Error {
  if (errorType === null) return target;
  Object.defineProperty(target, "errorType", {
    value: errorType,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

/**
 * Attach the SDK error CLASS name as a LEAN, NON-ENUMERABLE own-property
 * (`errorClass`) — same idiom as `attachStatus` / `attachCauseCode`.
 *
 * Unlike `errorType`, this value comes from a CLOSED dictionary
 * (`error-class.ts`): it identifies which `@openrouter/sdk` class was thrown,
 * which is our own compile-time dependency rather than provider-controlled
 * data. It is the ONLY discriminator for the six status-less shapes
 * (`SDKValidationError` + the five transports), which would otherwise reach
 * the classifier as `status: null` and be indistinguishable from an unknown
 * failure. No-op for `null`.
 */
export function attachErrorClass(target: Error, errorClass: string | null): Error {
  if (errorClass === null) return target;
  Object.defineProperty(target, "errorClass", {
    value: errorClass,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

/**
 * Attach the provider's retry hint, in whole seconds, as a LEAN,
 * NON-ENUMERABLE own-property (`retryAfterSeconds`). Parsed and bounded by
 * `retry-after.ts` from the original error's response headers BEFORE the raw
 * headers object is discarded — a small integer is the only thing that
 * survives. No-op for `null`.
 */
export function attachRetryAfterSeconds(
  target: Error,
  retryAfterSeconds: number | null,
): Error {
  if (retryAfterSeconds === null) return target;
  Object.defineProperty(target, "retryAfterSeconds", {
    value: retryAfterSeconds,
    enumerable: false,
    writable: false,
    configurable: true,
  });
  return target;
}

/**
 * Own-property readers used ONLY by the re-normalization fallback below: they
 * recover signals a PREVIOUS `normalizeOpenRouterError` pass already attached,
 * re-validating each through the same bounds so a second pass can never widen
 * what the first pass admitted.
 */
function ownProperty(err: Record<string, unknown>, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(err, key) ? err[key] : undefined;
}

function ownBoundedErrorClass(err: Record<string, unknown>): string | null {
  const value = ownProperty(err, "errorClass");
  return typeof value === "string" && OPENROUTER_ERROR_CLASSES.has(value)
    ? value
    : null;
}

function ownRetryAfterSeconds(err: Record<string, unknown>): number | null {
  const value = ownProperty(err, "retryAfterSeconds");
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function ownErrorType(err: Record<string, unknown>): string | null {
  return boundedErrorType(ownProperty(err, "errorType"));
}

/**
 * Normalize an unknown thrown value into a lean, redacted Error that preserves
 * the HTTP status as own-properties (`statusCode`/`status`) for the mission
 * auto-retry classifier, plus the errno-shaped `causeCode` own-property
 * (extracted from the ORIGINAL caught error including its `.cause` chain) for
 * environment diagnostics. Never serializes the raw error, its body, headers,
 * metadata, `openrouterMetadata`, or `userId` — and never attaches `.cause`.
 */
export function normalizeOpenRouterError(err: unknown, operation: string): Error {
  const fallbackMessage = err instanceof Error ? err.message : String(err);

  // Non-object throw (string/number/etc.): scrub the stringified form only.
  if (!isRecord(err)) {
    const scrubbed = scrubMessage(fallbackMessage);
    return new Error(`OpenRouter ${operation} failed: ${scrubbed ?? "unknown error"}`);
  }

  // `instanceof OpenRouterError` gives an authoritative numeric statusCode;
  // otherwise fall back to a numeric `statusCode` own-property if one exists.
  const status =
    err instanceof OpenRouterError ? err.statusCode : asFiniteNumber(err.statusCode);
  const code = extractErrorCode(err);
  const providerMessage = extractProviderMessage(err);
  const safeMessage = scrubMessage(providerMessage ?? fallbackMessage) ?? "unknown error";

  const details = [
    status !== null ? `status=${status}` : null,
    code !== null ? `code=${code}` : null,
    safeMessage,
  ].filter((part): part is string => part !== null);

  const normalized = new Error(`OpenRouter ${operation} failed: ${details.join(" | ")}`);

  // Attach the status + errno cause code as lean own-properties so the mission
  // classifier (status) and diagnostics call-sites (causeCode) read them
  // directly (own-property based, not message-regex) — never via `.cause`.
  //
  // The class name and the retry hint are captured from the ORIGINAL error
  // here, at the only point they still exist: `normalized` is a plain `Error`,
  // so its `name` is `"Error"` and its headers are gone. Both are bounded
  // (closed class dictionary; integer seconds) and carry no provider text.
  //
  // RE-NORMALIZATION: a mid-stream rejection reaches this function a second
  // time (`openrouter.ts` normalizes both the send and the iterator), and by
  // then the signals live only as own-properties on the already-normalized
  // error. Falling back to them keeps the second pass lossless instead of
  // silently erasing what the first pass captured.
  attachErrorClass(normalized, boundedErrorClass(err) ?? ownBoundedErrorClass(err));
  attachRetryAfterSeconds(
    normalized,
    retryAfterSecondsFromError(err) ?? ownRetryAfterSeconds(err),
  );
  attachErrorType(normalized, ownErrorType(err));
  return attachCauseCode(attachStatus(normalized, status), extractCauseCode(err));
}
