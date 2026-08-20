/**
 * Pure sanitizer for the engine-error `detail` field (owner decree 2026-08-02:
 * a failed operation states what actually happened, in agent-friendly words -
 * sanitized, never silenced). Strips URLs, bearer tokens, sk- provider keys
 * and long hex blobs, collapses whitespace and bounds length. Lives in
 * `shared/` because the main-side bridges apply it and tests exercise it pure.
 *
 * Order matters: URLs first (they can embed keys and hex), then tokens and
 * keys, then hex - so a secret inside a URL is gone before the narrower
 * patterns run.
 *
 * INVARIANT twin: `src/vex-agent/engine/runtime/error-detail-sanitizer.ts`
 * applies the SAME rules at bus emit. The two files cannot import each other
 * across the package boundary - keep patterns, constants and behavior
 * identical, and change both together with their boundary-case tests.
 */

/** Hard cap on a sanitized detail string. */
export const ENGINE_ERROR_DETAIL_MAX_LENGTH = 280;

/**
 * Hex blobs of HEX_BLOB_MIN_DIGITS or more digits (with or without a 0x
 * prefix) are treated as potential key material; 15 or fewer stay data.
 */
export const HEX_BLOB_MIN_DIGITS = 16;

const URL_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
const BEARER_PATTERN = /\bbearer\s+\S+/gi;
const PROVIDER_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{8,}\b/g;
const HEX_BLOB_PATTERN = /\b(?:0x)?[0-9a-fA-F]{16,}\b/g;

/**
 * Sanitize a raw error message into a renderer-safe detail string, or `null`
 * when there is nothing usable. Secrets never pass; prose does.
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
  // Length-cap decided by the owner spec; the cap is a bound on renderer-bound
  // prose, not agent context.
  return redacted.length > ENGINE_ERROR_DETAIL_MAX_LENGTH
    ? redacted.slice(0, ENGINE_ERROR_DETAIL_MAX_LENGTH)
    : redacted;
}
