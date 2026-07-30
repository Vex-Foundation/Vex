/**
 * `Retry-After` extraction from an OpenRouter error's response headers.
 *
 * WHY. The SDK exposes no `retryAfter` field on any error class, but
 * `OpenRouterError.headers` carries the header the provider actually sent. On
 * the 429 that motivated the error channel, the difference the user cares
 * about is "provider rate-limited" versus "provider rate-limited, retry in
 * 41s" — and a small integer of seconds is bounded, non-PII data, safe to
 * cross the IPC boundary.
 *
 * PRECEDENCE is the SDK's own (`esm/lib/retries.js:129-150`): `retry-after-ms`
 * first, then `retry-after` as either an integer count of seconds or an
 * HTTP-date. Deviating would make our advice contradict the SDK's internal
 * retry timing.
 *
 * BOUNDED. A provider-controlled number reaching the UI as "retry in N" must
 * not be able to say "retry in 3 million seconds". Values are clamped-by-
 * rejection (`null`) outside 1..`MAX_RETRY_AFTER_SECONDS`; sub-second waits
 * round up to 1 so "retry shortly" is still expressible, and a past date or a
 * zero wait resolves to `null` ("no useful hint") rather than 0.
 */

/**
 * Upper bound on an advertised wait, 24h. Anything longer is not a retry hint
 * a user can act on, and is far more likely a malformed header than a real
 * quota window.
 */
const MAX_RETRY_AFTER_SECONDS = 86_400;

function boundSeconds(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const rounded = Math.ceil(seconds);
  return rounded > MAX_RETRY_AFTER_SECONDS ? null : rounded;
}

/**
 * Minimal structural view of the `Headers` object the SDK attaches. Typed
 * structurally rather than as DOM `Headers` so this module stays usable
 * wherever the thrown value is only `unknown`.
 */
interface HeaderReader {
  readonly get: (name: string) => string | null;
}

function asHeaderReader(value: unknown): HeaderReader | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as { get?: unknown };
  return typeof candidate.get === "function" ? (value as HeaderReader) : null;
}

function readHeader(headers: HeaderReader, name: string): string | null {
  try {
    const raw = headers.get(name);
    return typeof raw === "string" && raw.trim().length > 0 ? raw.trim() : null;
  } catch {
    // A hostile/foreign `get` must not take down the error path.
    return null;
  }
}

/**
 * Parse a retry hint, in whole seconds, from a headers-like object. Returns
 * `null` when no usable hint is present. `now` is injectable so the HTTP-date
 * branch is testable without freezing global time.
 */
export function retryAfterSecondsFromHeaders(
  headers: unknown,
  now: number = Date.now(),
): number | null {
  const reader = asHeaderReader(headers);
  if (reader === null) return null;

  // Mirrors `esm/lib/retries.js:130-136` exactly, including the fall-THROUGH:
  // the SDK only accepts `retry-after-ms` when it parses finite AND >= 0, and
  // otherwise goes on to read `retry-after`. Returning early on a negative or
  // unparseable ms value would discard a perfectly good seconds header and
  // make our advice disagree with the SDK's own retry timing.
  const ms = readHeader(reader, "retry-after-ms");
  if (ms !== null) {
    const parsedMs = Number(ms);
    if (Number.isFinite(parsedMs) && parsedMs >= 0) {
      return boundSeconds(parsedMs / 1000);
    }
  }

  const retryAfter = readHeader(reader, "retry-after");
  if (retryAfter === null) return null;

  const asNumber = Number(retryAfter);
  if (Number.isInteger(asNumber)) return boundSeconds(asNumber);

  const asDate = Date.parse(retryAfter);
  if (Number.isFinite(asDate)) return boundSeconds((asDate - now) / 1000);

  return null;
}

/**
 * Convenience for a thrown value: reads `headers` as an own-property (the SDK
 * sets it on `OpenRouterError` instances) and parses the hint from it.
 */
export function retryAfterSecondsFromError(
  err: unknown,
  now: number = Date.now(),
): number | null {
  if (typeof err !== "object" || err === null) return null;
  if (!("headers" in err)) return null;
  return retryAfterSecondsFromHeaders((err as { headers: unknown }).headers, now);
}
