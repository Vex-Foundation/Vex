/**
 * Wall-clock bounds, evaluated INSIDE a tool batch.
 *
 * Both time bounds — the turn's `timeoutMs` slice guard and the mission's
 * frozen contract deadline — used to be sampled only at iteration boundaries.
 * One iteration is a model turn plus its ENTIRE parallel tool batch, so a batch
 * of slow DEX/RPC calls could overshoot either bound by an unbounded margin: the
 * loop simply had no place to notice until the batch finished.
 *
 * Checking here bounds the overshoot to a single tool call. That is the
 * strongest guarantee available and deliberately not stronger: the check runs at
 * the TOP of each per-call iteration and NEVER mid-dispatch, the same rule
 * operator Stop follows. A signing or broadcast call already in flight must
 * always be allowed to finish, because we cannot know whether it already moved
 * funds.
 */

export interface BatchDeadlines {
  /**
   * Absolute epoch ms at which this TURN's runtime slice expires
   * (`loop start + timeoutMs`). Exhaustion is a slice guard, not an outcome:
   * autonomous runners convert `timeout` into a continuation.
   */
  readonly turnTimeoutAtMs: number;
  /**
   * Absolute epoch ms of the mission's frozen contract deadline, or `null` for
   * a turn with no time-box (agent sessions, mission setup). A real business
   * outcome — it terminates the run.
   */
  readonly missionDeadlineAtMs: number | null;
}

export type BatchDeadlineBreach =
  | { readonly kind: "mission_deadline" }
  | { readonly kind: "turn_timeout" };

/**
 * Which bound, if any, has already passed at `nowMs`.
 *
 * The mission deadline is tested FIRST. When both have passed the contract
 * deadline is the truthful answer: it terminates the run, while `timeout` would
 * schedule a continuation for a mission that is no longer allowed to run.
 */
export function evaluateBatchDeadlines(
  deadlines: BatchDeadlines | undefined,
  nowMs: number,
): BatchDeadlineBreach | null {
  if (deadlines === undefined) return null;
  if (
    deadlines.missionDeadlineAtMs !== null
    && nowMs >= deadlines.missionDeadlineAtMs
  ) {
    return { kind: "mission_deadline" };
  }
  if (nowMs >= deadlines.turnTimeoutAtMs) return { kind: "turn_timeout" };
  return null;
}
