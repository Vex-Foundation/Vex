/**
 * How long a rate-limited provider told us to wait — as a bounded INTEGER of
 * seconds, or nothing.
 *
 * WHY THIS EXISTS. A 429 already reached the agent as "the provider is
 * rate-limiting; wait before retrying this venue" — true, and unusable: an
 * agent hitting Jupiter's ~10-requests-per-window limit is told to wait but not
 * how long, so it either retries immediately into the same wall or defers for
 * an invented interval. Every provider that limits us answers that question in
 * a header; nothing read them.
 *
 * WHAT MAY CROSS. A header value is untrusted external input (`rules/03`), so
 * only a validated integer in `[MIN, MAX]` leaves this module — never the raw
 * text, never a string, never an unbounded number. A provider that answers
 * `retry-after: <a novel>` or `retry-after: 999999999` yields `undefined`, and
 * the remedy falls back to its wording without a number.
 */

/**
 * A sub-second wait is not information an agent can act on, and a wait longer
 * than an hour is not a wait — it is a venue that is closed to us, where the
 * honest instruction stays "use another venue" rather than a number that would
 * read as a plan.
 */
const MIN_RETRY_AFTER_SECONDS = 1;
const MAX_RETRY_AFTER_SECONDS = 3600;

/**
 * `x-ratelimit-reset` is the one genuinely ambiguous header in the set: some
 * providers send a delta in seconds, others a Unix epoch in seconds, others
 * epoch milliseconds. The magnitude is what tells them apart, and these are the
 * thresholds — anything at or above them cannot plausibly be a delta, since a
 * delta that large is already outside `MAX_RETRY_AFTER_SECONDS`.
 */
const EPOCH_MILLIS_THRESHOLD = 1e12;
const EPOCH_SECONDS_THRESHOLD = 1e9;

const HTTP_TOO_MANY_REQUESTS = 429;

function boundedSeconds(value: number): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  const seconds = Math.ceil(value);
  return seconds >= MIN_RETRY_AFTER_SECONDS && seconds <= MAX_RETRY_AFTER_SECONDS
    ? seconds
    : undefined;
}

/**
 * RFC 9110 `Retry-After`: either delta-seconds or an HTTP-date. Both forms are
 * reduced to a delta here so no caller has to know which one arrived.
 */
function parseRetryAfter(raw: string, nowMs: number): number | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  if (/^\d+$/.test(trimmed)) return boundedSeconds(Number(trimmed));
  const dateMs = Date.parse(trimmed);
  return Number.isNaN(dateMs) ? undefined : boundedSeconds((dateMs - nowMs) / 1000);
}

/** A `x-ratelimit-reset`-style value, disambiguated by magnitude. */
function parseResetValue(raw: string, nowMs: number): number | undefined {
  const trimmed = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(trimmed)) return undefined;
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return undefined;
  if (value >= EPOCH_MILLIS_THRESHOLD) return boundedSeconds((value - nowMs) / 1000);
  if (value >= EPOCH_SECONDS_THRESHOLD) return boundedSeconds(value - nowMs / 1000);
  return boundedSeconds(value);
}

/**
 * The wait a rate-limited response advertises, in whole seconds.
 *
 * `Retry-After` is read on ANY error status, because that is exactly what the
 * header means wherever it appears (429 and 503 both). The `x-ratelimit-*`
 * family is read ONLY on a 429: on any other status those headers describe the
 * window's state, not an instruction to wait, and turning window bookkeeping
 * into "wait 47s" would be a claim the response never made (`rules/90`).
 */
export function readRetryAfterSeconds(
  headers: Headers,
  status: number,
  nowMs: number = Date.now(),
): number | undefined {
  const retryAfter = headers.get("retry-after");
  if (retryAfter !== null) {
    const parsed = parseRetryAfter(retryAfter, nowMs);
    if (parsed !== undefined) return parsed;
  }
  if (status !== HTTP_TOO_MANY_REQUESTS) return undefined;

  for (const header of ["x-ratelimit-reset-after", "x-ratelimit-reset"] as const) {
    const raw = headers.get(header);
    if (raw === null) continue;
    const parsed = parseResetValue(raw, nowMs);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}
