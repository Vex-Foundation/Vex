/**
 * Bound ONE leg of a multi-source read by a deadline, and say so when it fires.
 *
 * WHY A DISCRIMINATED OUTCOME AND NOT A THROW. The callers are balance reads,
 * where a leg that did not answer must be reported as UNKNOWN, never as zero
 * and never as a generic failure the model might retry blindly. Returning
 * `{ kind: "deadline" }` makes the caller write that case out explicitly.
 *
 * HOW THIS RESPECTS THE `cancellation.ts` RULES.
 *  - The work RECEIVES the deadline as an abort signal (composed with the
 *    caller's), so a leg that honours signals releases its sockets when the
 *    deadline fires. The wait is additionally bounded on its own, so a leg that
 *    ignores its signal can delay nothing: its late answer is dropped, and it
 *    can never write into the caller's result because the caller only reads
 *    the settled value.
 *  - A caller abort and a deadline stay distinguishable: a caller abort always
 *    rethrows the caller signal's own reason; only the deadline yields
 *    `{ kind: "deadline" }`.
 *
 * `deadlineMs <= 0` is "no deadline": the work runs with the caller's signal
 * exactly as it did before this module existed, and the outcome is always
 * `settled`.
 */

export type DeadlineOutcome<T> =
  | { readonly kind: "settled"; readonly value: T }
  | { readonly kind: "deadline" };

/** The reason a deadline abort carries, so a leg can tell it from a Stop. */
export class LegDeadlineError extends Error {
  constructor(readonly deadlineMs: number) {
    super(`deadline of ${deadlineMs}ms reached`);
    this.name = "LegDeadlineError";
  }
}

export async function runWithinDeadline<T>(
  deadlineMs: number,
  callerSignal: AbortSignal | undefined,
  work: (signal: AbortSignal | undefined) => Promise<T>,
): Promise<DeadlineOutcome<T>> {
  if (!(deadlineMs > 0)) {
    return { kind: "settled", value: await work(callerSignal) };
  }
  callerSignal?.throwIfAborted();

  const deadline = new AbortController();
  const signal = callerSignal === undefined
    ? deadline.signal
    : AbortSignal.any([callerSignal, deadline.signal]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<{ readonly kind: "deadline" }>((resolve) => {
    timer = setTimeout(() => {
      deadline.abort(new LegDeadlineError(deadlineMs));
      resolve({ kind: "deadline" });
    }, deadlineMs);
  });
  let onCallerAbort: (() => void) | undefined;
  const callerStopped = callerSignal === undefined
    ? undefined
    : new Promise<never>((_resolve, reject) => {
        onCallerAbort = (): void => reject(callerSignal.reason);
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      });
  callerStopped?.catch(() => undefined);

  const settled = (async (): Promise<DeadlineOutcome<T>> => {
    try {
      return { kind: "settled", value: await work(signal) };
    } catch (err) {
      if (callerSignal?.aborted === true) throw callerSignal.reason;
      // The leg failed BECAUSE the deadline aborted it: that is the deadline's
      // outcome, not a provider failure.
      if (deadline.signal.aborted) return { kind: "deadline" };
      throw err;
    }
  })();
  // A late rejection after the deadline won must not surface as unhandled.
  settled.catch(() => undefined);

  try {
    const contenders: Array<Promise<DeadlineOutcome<T>>> = [settled, expired];
    if (callerStopped !== undefined) contenders.push(callerStopped);
    const outcome = await Promise.race(contenders);
    if (outcome.kind === "deadline") callerSignal?.throwIfAborted();
    return outcome;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    if (onCallerAbort !== undefined) callerSignal?.removeEventListener("abort", onCallerAbort);
  }
}
