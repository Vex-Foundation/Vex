/**
 * Per-caller bounds on a SHARED DexScreener request.
 *
 * MOVED VERBATIM out of `client.ts` (S11a) so the REST client and the
 * `price-read.ts` seam cannot drift on it while both exist. The rule below is
 * the reason the seam could not simply forward a caller's deadline into the
 * transport, so it travels with the code that needs it rather than being
 * re-derived at the new owner.
 *
 * ## They bound the WAIT, NOT the request, and that distinction is load-bearing
 *
 * The throttle dedupes by URL: two callers asking for the same token in the same
 * moment SHARE one in-flight request. If a caller's `timeoutMs`/`signal` were
 * handed to that shared fetch, they would leak sideways:
 *
 *   - the price poller's 5 s deadline would silently become an agent call's
 *     deadline, failing a request the agent had 30 s of patience for;
 *   - a poller attaching to an already-running 30 s request would inherit ITS
 *     deadline, so shutdown would wait rather than abort;
 *   - the poller's shutdown abort would cancel the agent's request outright.
 *
 * So the shared request always runs under the DEFAULT policy, and these options
 * only decide how long this caller waits for it and when it walks away. A caller
 * that walks away leaves the shared request running for whoever else wants it.
 */

import { VexError, ErrorCodes } from "../../errors.js";

export interface DexScreenerRequestOptions {
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

/** Whether these options ask for anything at all. A guard, so no `!` is needed. */
export function boundsTheWait(
  options?: DexScreenerRequestOptions,
): options is DexScreenerRequestOptions {
  return options !== undefined
    && (options.timeoutMs !== undefined || options.signal !== undefined);
}

/**
 * Wait for `shared`, giving up on the caller's own deadline or abort.
 *
 * Giving up NEVER touches `shared`; the rejection handler below only stops Node
 * reporting an unhandled rejection for a promise this caller stopped watching.
 * A deadline breach is reported as `HTTP_TIMEOUT` exactly as `fetchWithTimeout`
 * would have, and a caller abort propagates as the signal's own reason, so "the
 * operator stopped" is never rendered as "the provider hung".
 */
export async function awaitWithinCallerBounds<T>(
  shared: Promise<T>,
  options: DexScreenerRequestOptions,
): Promise<T> {
  shared.catch(() => undefined);

  const abandon = new AbortController();
  const reasons: Promise<never>[] = [];

  if (options.timeoutMs !== undefined) {
    const timeoutMs = options.timeoutMs;
    reasons.push(new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new VexError(
          ErrorCodes.HTTP_TIMEOUT,
          `Request timed out after ${timeoutMs}ms`,
          "Check network connectivity or try again later",
        ));
      }, timeoutMs);
      abandon.signal.addEventListener("abort", () => clearTimeout(timer));
    }));
  }

  if (options.signal !== undefined) {
    const callerSignal = options.signal;
    reasons.push(new Promise<never>((_resolve, reject) => {
      if (callerSignal.aborted) {
        reject(callerSignal.reason ?? new DOMException("Aborted", "AbortError"));
        return;
      }
      const onAbort = () =>
        reject(callerSignal.reason ?? new DOMException("Aborted", "AbortError"));
      callerSignal.addEventListener("abort", onAbort, { once: true });
      abandon.signal.addEventListener("abort", () =>
        callerSignal.removeEventListener("abort", onAbort));
    }));
  }

  try {
    return await Promise.race([shared, ...reasons]);
  } finally {
    // Release the timer and the abort listener whatever the outcome.
    abandon.abort();
  }
}
