/**
 * Request-deadline composition for OpenRouter sends.
 *
 * WHY THIS EXISTS — installed-SDK evidence, not documentation. The SDK arms the
 * client's configured `timeoutMs` ONLY for sends that pass no signal
 * (`node_modules/@openrouter/sdk/esm/lib/sdks.js`):
 *
 *   :151  if (!fetchOptions?.signal && conf.timeoutMs != null && conf.timeoutMs > 0)
 *   :152      context.timeoutMs = conf.timeoutMs;
 *   :178  const timeoutMs = context.timeoutMs;
 *   :182  if (timeoutMs != null && timeoutMs > 0) {
 *   :183      const timeoutSignal = AbortSignal.timeout(timeoutMs);
 *   :184      const combined = combineSignals(cloned.signal, timeoutSignal) ?? timeoutSignal;
 *
 * So a caller-supplied signal does not merely take precedence — it DISABLES the
 * configured ceiling outright, because `context.timeoutMs` is never set and `_do`
 * then composes no timeout at all. Passing a raw caller signal leaves a hung
 * provider call with no upper bound. This module composes the two instead, so
 * cancellation is gained without the deadline being lost.
 *
 * Two properties the callers depend on:
 *
 *   - **No caller signal ⇒ `undefined`.** The send then passes no options object,
 *     the SDK arms its own timeout as before, and the call stays byte-identical
 *     for callers that use no cancellation.
 *   - **The deadline stays distinguishable from a user stop.** `AbortSignal.timeout`
 *     aborts with a `TimeoutError`, `AbortController.abort()` with an `AbortError`,
 *     and `AbortSignal.any` adopts whichever source fired. Downstream code that
 *     must tell "the user stopped" from "the provider hung" (`stream-consumer.ts`)
 *     reads the CALLER's signal, which a deadline abort never touches.
 *
 * Composing here rather than inside the SDK moves the ceiling from per-retry-attempt
 * to per-send — strictly the tighter bound, and well clear of the client's own
 * 60 s `maxElapsedTime` retry envelope.
 */

/**
 * Compose a caller's cancellation with the configured request deadline.
 *
 * Returns `undefined` when there is nothing to cancel, so the SDK keeps arming
 * its own equivalent timeout (see module doc). `deadlineMs` is a build-time
 * constant, never external input.
 */
export function composeRequestDeadline(
  callerSignal: AbortSignal | undefined,
  deadlineMs: number,
): AbortSignal | undefined {
  if (callerSignal === undefined) return undefined;
  // The timeout signal's timer is unref'd by Node, so an early-completing
  // request never holds the process open waiting for a deadline it beat.
  return AbortSignal.any([callerSignal, AbortSignal.timeout(deadlineMs)]);
}
