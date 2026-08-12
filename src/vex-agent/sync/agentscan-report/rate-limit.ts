/**
 * The ingest lane's own request budget.
 *
 * WHY IT EXISTS. The server rate-limits a token at 60 requests per minute and
 * answers 429 above it. The drain sends up to `AGENTSCAN_MAX_BATCHES_PER_TICK`
 * batches per tick (and a tick can send two envelopes when a claim mixes
 * backfill and incremental rows), while the push lane can tick every couple of
 * seconds behind a trailing debounce. A busy backfill can therefore issue far
 * more than 60 requests in a minute, and the rows that hit the ceiling come
 * back as 429s with server-imposed backoff — self-inflicted throttling for
 * traffic we could simply have paced.
 *
 * THE BUDGET IS DELIBERATELY BELOW THE CEILING. The events endpoint is not the
 * only thing this install asks of the server: the handshake, its retries, and
 * the drain's own retries share the same token. Spending the entire ceiling on
 * event batches would make a re-handshake the request that gets refused.
 *
 * REFUSING BEATS SLEEPING. A caller that has no slot stops draining rather than
 * waiting: this lane runs inside the shared sync worker, and sleeping there
 * stalls balance and activity sync as well. Nothing is lost — outbox rows stay
 * owed and the next tick continues where this one stopped.
 */

/** The server's documented per-token ceiling. Not our budget — the thing our budget stays under. */
const SERVER_REQUESTS_PER_MINUTE = 60;

/** Headroom reserved for the handshake, its retries, and the drain's own retries. */
const RESERVED_FOR_HANDSHAKE_AND_RETRIES = 20;

/** What the event drain may spend in any trailing 60 s window. */
export const AGENTSCAN_MAX_SENDS_PER_MINUTE =
  SERVER_REQUESTS_PER_MINUTE - RESERVED_FOR_HANDSHAKE_AND_RETRIES;

const WINDOW_MS = 60_000;

/**
 * Timestamps of the sends counted in the current trailing window. Module state
 * because the budget belongs to the TOKEN, which this process holds exactly one
 * of; it is reached only through the functions below, never exported directly.
 */
const sendTimestamps: number[] = [];

/**
 * Take one send slot, or report that the budget is spent.
 *
 * Call it immediately BEFORE the request, not after: the point is to decide
 * whether the request may happen at all.
 */
export function tryConsumeAgentscanSendSlot(now: number = Date.now()): boolean {
  const windowStart = now - WINDOW_MS;
  while (sendTimestamps.length > 0 && (sendTimestamps[0] ?? 0) <= windowStart) {
    sendTimestamps.shift();
  }
  if (sendTimestamps.length >= AGENTSCAN_MAX_SENDS_PER_MINUTE) return false;
  sendTimestamps.push(now);
  return true;
}

/** Drop the window. For tests, which must not depend on another suite's spending. */
export function resetAgentscanSendRateWindow(): void {
  sendTimestamps.length = 0;
}
