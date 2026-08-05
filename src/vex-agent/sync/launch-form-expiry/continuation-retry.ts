/**
 * WHEN a failed form continuation may be tried again — and when it must stop.
 *
 * ## The loop this exists to end
 *
 * The durable floor retries anything still owed on every ~60s sweep. That is
 * the right default for a busy lease and the wrong one for a failure that
 * cannot improve: intent aa5401f2 logged
 * `trench.launch_form_expiry.resume_failed status=400` once a minute,
 * indefinitely, because the sweep had no memory of having already tried.
 *
 * So the sweep gets a memory, and it is deliberately PROCESS-LOCAL:
 *
 *   attempt 1 fails → next attempt no sooner than 60s (the next sweep)
 *   attempt 2 fails → no sooner than 5 minutes
 *   attempt 3 fails → dormant for the rest of this process
 *
 * "Dormant" and not "closed": a restart genuinely changes the conditions a
 * resume runs under (a stuck lease is gone, a provider outage has passed, a
 * bad build has been replaced), so the next app start gets one more ladder.
 * Nothing durable is written for a transient failure, because nothing durable
 * is KNOWN — the turn is still owed.
 *
 * ## The one failure that IS written down
 *
 * A deterministic provider refusal — a 4xx that is not a timeout and not rate
 * limiting — repeated on two consecutive attempts against an unchanged prompt
 * proves the attempt itself is wrong, not its timing. A third attempt would be
 * identical to the second. That parks the continuation permanently, with a
 * named reason, instead of waiting for a restart to repeat the same refusal.
 *
 * "Unchanged prompt" is not assumed: the caller passes the row facts that would
 * alter what the resume sends (its result stamp and its status), and any change
 * there resets the pair. The comparison is on the SIGNATURE — a scrubbed error
 * code and HTTP status, never message text, which can carry session content.
 *
 * Pure policy: a map, a clock, and no I/O. The sweep owns every write.
 */

/** The ladder, in order. One entry per failure before dormancy. */
const RETRY_DELAYS_MS = [60_000, 5 * 60_000] as const;

/**
 * What a failed attempt means for the next one.
 *
 * `park` is the only outcome that asks the caller to write anything durable.
 */
export type ContinuationRetryDecision =
  | { readonly kind: "retry_after"; readonly delayMs: number }
  | { readonly kind: "dormant_until_restart" }
  | { readonly kind: "park"; readonly reason: "resume_failed_deterministic" };

/**
 * The failure, reduced to what the policy may compare.
 *
 * `deterministic` is the caller's classification (it owns the error
 * vocabulary); `signature` is a stable, scrubbed identity for "the same refusal
 * as last time".
 */
export interface ContinuationFailure {
  readonly deterministic: boolean;
  readonly signature: string;
}

/** The row facts that change what a resume would send. */
export interface ContinuationPromptFacts {
  readonly resultMessageId: number | null;
  readonly status: string;
}

interface AttemptRecord {
  failures: number;
  nextAttemptAt: number;
  dormant: boolean;
  lastFailure: ContinuationFailure | null;
  lastPrompt: ContinuationPromptFacts;
}

const attempts = new Map<string, AttemptRecord>();

function samePrompt(a: ContinuationPromptFacts, b: ContinuationPromptFacts): boolean {
  return a.resultMessageId === b.resultMessageId && a.status === b.status;
}

/**
 * Whether the sweep may attempt this continuation now.
 *
 * A row it has never failed on is always due — the ladder is a consequence of
 * failure, not a queue every continuation waits in.
 */
export function isContinuationDue(intentId: string, now: number): boolean {
  const record = attempts.get(intentId);
  if (record === undefined) return true;
  if (record.dormant) return false;
  return now >= record.nextAttemptAt;
}

/**
 * Record a failed attempt and say what happens next.
 *
 * A change in the prompt facts starts a fresh ladder: the previous failures
 * were about a different request, and holding them against this one would park
 * a resume that has not actually been refused twice.
 */
export function noteContinuationFailure(input: {
  readonly intentId: string;
  readonly failure: ContinuationFailure;
  readonly prompt: ContinuationPromptFacts;
  readonly now: number;
}): ContinuationRetryDecision {
  const previous = attempts.get(input.intentId);
  const carried =
    previous !== undefined && samePrompt(previous.lastPrompt, input.prompt)
      ? previous
      : undefined;

  if (
    input.failure.deterministic
    && carried?.lastFailure?.deterministic === true
    && carried.lastFailure.signature === input.failure.signature
  ) {
    attempts.delete(input.intentId);
    return { kind: "park", reason: "resume_failed_deterministic" };
  }

  const failures = (carried?.failures ?? 0) + 1;
  const delayMs = RETRY_DELAYS_MS[failures - 1];
  if (delayMs === undefined) {
    attempts.set(input.intentId, {
      failures,
      nextAttemptAt: Number.POSITIVE_INFINITY,
      dormant: true,
      lastFailure: input.failure,
      lastPrompt: input.prompt,
    });
    return { kind: "dormant_until_restart" };
  }

  attempts.set(input.intentId, {
    failures,
    nextAttemptAt: input.now + delayMs,
    dormant: false,
    lastFailure: input.failure,
    lastPrompt: input.prompt,
  });
  return { kind: "retry_after", delayMs };
}

/**
 * Forget a continuation the sweep no longer owes anything to — delivered,
 * closed, or nothing parked.
 *
 * Keeping the record would leak one entry per launch for the life of the
 * process, and would hold a stale ladder against an intent id that came back.
 */
export function forgetContinuation(intentId: string): void {
  attempts.delete(intentId);
}
