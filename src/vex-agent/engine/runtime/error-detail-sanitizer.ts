/**
 * Sanitizer for the engine-error `detail` field, applied AT BUS EMIT so no
 * in-process subscriber (bridges, future log sinks) can ever observe a secret
 * in the event payload. Strips URLs first (they can embed keys and hex), then
 * bearer tokens and sk- provider keys, then long hex blobs; collapses
 * whitespace and bounds length.
 *
 * INVARIANT twin: `vex-app/src/shared/engine-error-sanitizer.ts` applies the
 * SAME rules at the renderer bridge (defense in depth). The two files cannot
 * import each other across the package boundary - keep patterns, constants
 * and behavior identical, and change both together with their boundary-case
 * tests.
 */

/** Hard cap on a sanitized detail string (renderer-bound prose bound). */
export const ENGINE_ERROR_DETAIL_MAX_LENGTH = 280;

/** Hex blobs of this many digits or more are treated as potential keys. */
export const HEX_BLOB_MIN_DIGITS = 16;

const URL_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
const BEARER_PATTERN = /\bbearer\s+\S+/gi;
const PROVIDER_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const HEX_BLOB_PATTERN = /\b(?:0x)?[0-9a-fA-F]{16,}\b/g;

/**
 * Sanitize a raw error message into a subscriber-safe detail string, or
 * `null` when there is nothing usable. Secrets never pass; prose does.
 */
export function sanitizeEngineErrorDetail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const redacted = raw
    .replace(URL_PATTERN, "[url]")
    .replace(BEARER_PATTERN, "[token]")
    .replace(PROVIDER_KEY_PATTERN, "[key]")
    .replace(HEX_BLOB_PATTERN, "[hex]")
    .replace(/\s+/g, " ")
    .trim();
  if (redacted.length === 0) return null;
  return redacted.length > ENGINE_ERROR_DETAIL_MAX_LENGTH
    ? redacted.slice(0, ENGINE_ERROR_DETAIL_MAX_LENGTH)
    : redacted;
}
