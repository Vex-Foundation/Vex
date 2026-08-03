/**
 * Signal-aware timing primitives — the module that owns "wait, poll, or bound a
 * call in a way an operator Stop can interrupt".
 *
 * WHY THIS EXISTS. Every sleep, poll, and quota wait in the tool surface was
 * hand-rolled and unabortable, so a Stop pressed inside a tool could not land
 * for up to two minutes. These four functions are the only waiting shapes the
 * adopting sites need; handlers pass the turn's signal in and never construct
 * one themselves.
 *
 * TWO RULES ENCODED HERE, both learned the hard way in this repo:
 *
 *  - **Never `Promise.race([work, timeout])`.** It settles the race but leaves
 *    the work running with its resources held — the failure already documented
 *    inline at `compact-jobs/chunker-call.ts` and `memory/manager/judge.ts`.
 *    `delay` is backed by `node:timers/promises.setTimeout(ms, undefined,
 *    {signal})`, which clears its own timer on abort.
 *  - **A caller abort and a deadline breach must stay distinguishable.**
 *    `AbortController.abort()` produces an `AbortError`, `AbortSignal.timeout`
 *    a `TimeoutError`, and `AbortSignal.any` adopts whichever fired. Everything
 *    here rejects with the SIGNAL'S OWN reason so "the user stopped" is never
 *    mistaken for "the provider hung".
 *
 * NOT for sign → broadcast → persist windows. Those legs take no signal at all
 * (see `@tools/evm-chains/staged-broadcast.ts`); a signal that cannot be passed
 * cannot be observed.
 */

import { setTimeout as setTimeoutPromise } from "node:timers/promises";

export type PollOutcome<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "exhausted" }
  | { readonly kind: "aborted" };

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal !== undefined && signal.aborted;
}

/**
 * True only for a CALLER abort (`AbortController.abort()`), never for a
 * deadline breach.
 *
 * The distinction is the whole point: `AbortSignal.timeout` rejects with a
 * `TimeoutError` and `AbortSignal.any` adopts whichever fired, so testing "is
 * the signal aborted?" would report a hung provider as "the operator stopped".
 * Hence the test is on the error's own `name`.
 */
export function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

/** Throw the signal's own reason (`AbortError` or `TimeoutError`) if it aborted. */
export function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/**
 * Sleep that a Stop cancels, rejecting with the signal's reason.
 *
 * With no signal the wait uses the plain global timer, which keeps the
 * no-cancellation path byte-identical (and fake-timer controllable) for the
 * callers that have nothing to cancel.
 */
export async function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal === undefined) {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, ms);
    });
    return;
  }
  try {
    await setTimeoutPromise(ms, undefined, { signal });
  } catch (err) {
    // `timers/promises` rejects with its own AbortError wrapper; re-throw the
    // signal's reason so a deadline stays a TimeoutError for the caller.
    throwIfAborted(signal);
    throw err;
  }
}

/**
 * Bounded poll with a cancellable inter-attempt wait.
 *
 * The signal is checked before each attempt and observed inside the wait, so an
 * abort lands immediately rather than at the next interval boundary. Never
 * throws for "not settled yet" — the outcome is discriminated.
 */
export async function pollUntil<T>(input: {
  readonly attempts: number;
  readonly intervalMs: number;
  readonly signal?: AbortSignal;
  readonly attempt: (signal?: AbortSignal) => Promise<T | undefined>;
}): Promise<PollOutcome<T>> {
  const { attempts, intervalMs, signal, attempt } = input;

  for (let index = 0; index < attempts; index += 1) {
    if (isAborted(signal)) return { kind: "aborted" };

    const value = await attempt(signal);
    if (value !== undefined) return { kind: "settled", value };

    if (index === attempts - 1) break;

    try {
      await delay(intervalMs, signal);
    } catch (err) {
      if (isAborted(signal)) return { kind: "aborted" };
      throw err;
    }
  }

  return { kind: "exhausted" };
}

/**
 * Compose a caller's cancellation with a request deadline.
 *
 * Returns `undefined` when there is nothing to cancel, so a caller with no
 * signal keeps whatever timeout the underlying client already arms — supplying
 * a naked caller signal to an SDK or transport typically DISABLES its ceiling
 * (see `@vex-agent/inference/openrouter/request-deadline.ts` for the installed-
 * SDK evidence), which is exactly what composing here prevents.
 *
 * `deadlineMs` is a build-time constant, never external input.
 */
export function composeDeadline(
  callerSignal: AbortSignal | undefined,
  deadlineMs: number,
): AbortSignal | undefined {
  if (callerSignal === undefined) return undefined;
  // The timeout signal's timer is unref'd by Node, so an early-completing call
  // never holds the process open waiting for a deadline it beat.
  return AbortSignal.any([callerSignal, AbortSignal.timeout(deadlineMs)]);
}
