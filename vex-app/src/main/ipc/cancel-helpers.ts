/**
 * Helpers for the cancellation contract introduced in PR3.
 *
 * - `raceWithAbort`: returns the input promise's resolution unless the
 *   provided `AbortSignal` aborts first, in which case rejects with an
 *   AbortError. Always cleans up the abort listener on every exit
 *   path (resolve, reject, abort) to avoid leaking listeners on the
 *   shared controller — which matters for a single-flight join path
 *   (the runtime host's start), where many joined waiters may attach to
 *   the same shared promise.
 *
 * - `isAbortError`: best-effort check for "this rejection came from an
 *   aborted signal". Node + the DOM both use `error.name === "AbortError"`,
 *   but we also accept anything that already implements that shape.
 *
 * - `cancelledError`: factory for the `internal.cancelled` VexError.
 *   Centralised so every cancellation surface returns the same shape
 *   (and the same user-facing message).
 *
 * These helpers are unit-testable in isolation — no Electron, no IPC.
 */

import type { VexDomain, VexError } from "@shared/ipc/result.js";

export class AbortError extends Error {
  constructor(message = "The operation was aborted.") {
    super(message);
    this.name = "AbortError";
  }
}

export function isAbortError(value: unknown): boolean {
  if (value instanceof AbortError) return true;
  if (value instanceof Error && value.name === "AbortError") return true;
  // DOMException with name "AbortError" — what fetch / standard APIs
  // throw when their signal aborts mid-flight.
  if (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    (value as { name?: unknown }).name === "AbortError"
  ) {
    return true;
  }
  return false;
}

/**
 * Wait for `promise` to settle, unless `signal` aborts first. When the
 * signal aborts, this rejects with an `AbortError` regardless of what
 * the underlying promise eventually resolves/rejects to — the listener
 * is removed and the result of the inner promise is dropped on the
 * floor (we never see it; it does NOT block GC).
 *
 * If `signal` is undefined, this is a transparent pass-through.
 *
 * Critically: this does NOT call `controller.abort()` on the upstream
 * promise's source. It only stops awaiting. Joined callers of a
 * single-flight start use this to detach from the shared in-flight
 * promise without aborting the shared work — only the initiator's
 * signal flows into it.
 */
export async function raceWithAbort<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  if (signal === undefined) {
    return await promise;
  }
  if (signal.aborted) {
    throw new AbortError();
  }
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener("abort", onAbort);
      reject(new AbortError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (cause) => {
        signal.removeEventListener("abort", onAbort);
        reject(cause);
      },
    );
  });
}

/**
 * Canonical `internal.cancelled` VexError. `retryable: true` because
 * the user can always re-trigger the original action; `userActionable:
 * false` because the cancellation itself is not something the user
 * needs to act on — it's the response to their already-issued cancel.
 *
 * `redacted: true` is the required literal invariant on the IPC
 * boundary. `message` is intentionally generic ("Operation cancelled.")
 * — surface-specific copy (e.g. "Startup cancelled.") is the renderer's
 * responsibility via `error-copy.ts`.
 */
export function cancelledError(
  domain: VexDomain,
  correlationId: string,
): VexError {
  return {
    code: "internal.cancelled",
    domain,
    message: "Operation cancelled.",
    retryable: true,
    userActionable: false,
    redacted: true,
    correlationId,
  };
}
