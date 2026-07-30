/**
 * How long to wait before re-attempting a capacity failure, and how many
 * attempts a single send is allowed.
 *
 * The provider's `Retry-After` is honoured when present — deviating would make
 * us contradict the SDK's own retry timing. But the live probe
 * (`provider-429-layer`, 2026-07-29) recorded a real 429 with NEITHER
 * `retry-after` NOR `retry-after-ms`, so the null case is the COMMON case here,
 * not the exception: the policy has its own bounded exponential backoff and
 * never depends on the header existing.
 *
 * A hint LONGER than {@link MAX_HONOURED_RETRY_AFTER_SECONDS} is not waited
 * out — holding a chat turn for 41 s is worse for the user than moving to a
 * healthier endpoint. `null` from {@link nextRetryDelayMs} means exactly that:
 * "do not sleep on this endpoint", which the caller reads as "escalate to the
 * switch decision now".
 *
 * Pure module: no timers, no logger, no IO. The caller owns the sleep.
 */

/**
 * Total attempts one send may make, including the first. Two on the current
 * endpoint (owner decision 9: "two consecutive failures, then switch") plus one
 * on the switched endpoint. Deliberately small: mission auto-retry can wrap
 * this up to 5 times, and the switch is session-sticky (decision 10), so
 * attempts must not multiply.
 */
export const MAX_CAPACITY_ATTEMPTS = 3;

/**
 * Consecutive capacity failures on the session's current endpoint before a
 * switch is attempted (owner decision 9).
 */
export const CONSECUTIVE_FAILURES_BEFORE_SWITCH = 2;

/** First backoff step when the provider gives no hint. */
export const BASE_RETRY_DELAY_MS = 1_000;

/** Ceiling on our own exponential backoff. */
export const MAX_RETRY_DELAY_MS = 8_000;

/**
 * Longest provider-advertised wait we will actually sit through. Above this we
 * stop waiting and let the failover decide; the hint is still logged.
 */
export const MAX_HONOURED_RETRY_AFTER_SECONDS = 10;

/**
 * Delay before the next attempt, or `null` when this endpoint should not be
 * retried at all (the advertised wait is longer than we are willing to hold a
 * turn for).
 *
 * @param attemptsMade attempts already completed for this send (>= 1).
 * @param retryAfterSeconds provider hint in whole seconds, or `null`.
 */
export function nextRetryDelayMs(
  attemptsMade: number,
  retryAfterSeconds: number | null,
): number | null {
  if (retryAfterSeconds !== null) {
    if (retryAfterSeconds > MAX_HONOURED_RETRY_AFTER_SECONDS) return null;
    return retryAfterSeconds * 1_000;
  }
  const exponent = Math.max(0, attemptsMade - 1);
  return Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
}
