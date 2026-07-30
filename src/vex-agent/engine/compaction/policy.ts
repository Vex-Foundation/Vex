/**
 * Compaction preparation worker policy — the constants the ENGINE side owns.
 *
 * OWNERSHIP SPLIT (deliberate, wave sequencing decision). Lease, attempt,
 * stale-threshold and backoff constants live in
 * `db/repos/compaction-preparations/policy.ts`, because the DB CAS predicates
 * and the column DEFAULTs in `058_compaction_preparations.sql` are written
 * against those exact numbers. This module must never re-declare them; it
 * imports and re-exports nothing of theirs. What lives here is what only a
 * worker has an opinion about: how often it polls, how long it waits for the
 * model, and how long a summary may be.
 *
 * No DB, no I/O — plain constants and one pure helper.
 */

/**
 * Branch-A poll cadence.
 *
 * DIFFERENT from the branch-B cadence on purpose. The claim takes a ROW lock
 * (`SELECT ... FOR UPDATE SKIP LOCKED`), not a column-set lock, so two claims
 * for different branches of the SAME row landing in the same instant do not
 * both succeed — the loser skips and takes the row on its next poll. Nothing is
 * lost, but identical, perfectly-synchronised intervals would make that
 * collision the common case instead of the rare one. Different periods plus
 * jitter keep the two loops out of phase.
 */
export const SUMMARY_POLL_INTERVAL_MS = 5_000;

/** Branch-B poll cadence — see the phase-separation rationale above. */
export const CHUNKS_POLL_INTERVAL_MS = 7_000;

/**
 * Fraction of the base interval added as random jitter (0 → +20%). Two app
 * instances started by the same script would otherwise poll in lockstep for
 * their whole lifetime.
 */
export const POLL_JITTER_RATIO = 0.2;

/**
 * Per-LLM-call deadline for branch A.
 *
 * 90s for the same reason `compact-jobs/policy.ts` documents: the OpenRouter
 * client carries a `maxElapsedTime: 60000` backoff envelope, so a shorter
 * deadline cancels calls the SDK is still legitimately retrying and burns an
 * attempt on a transient 429. It also sits well under
 * `BRANCH_STALE_THRESHOLD_MS` (120s) with a 20s heartbeat, so an in-flight
 * call can never be mistaken for a dead worker.
 *
 * CROSS-PACKAGE: the critical-pressure path derives its bounded wait for an
 * in-flight branch-A attempt from THIS constant (contract C8 — "bounded wait
 * for the CURRENT attempt only"). Renaming or re-deriving it elsewhere breaks
 * that alignment silently.
 */
export const SUMMARY_CALL_TIMEOUT_MS = 90_000;

/** Per-LLM-call deadline for branch B. Same envelope reasoning as branch A. */
export const CHUNKS_CALL_TIMEOUT_MS = 90_000;

/**
 * Lower bound on an accepted branch-A summary, applied AFTER redaction.
 *
 * A zero-length summary is not "an empty conversation" — the summary REPLACES
 * `sessions.summary` at cutover, so accepting one would erase every earlier
 * compacted history the corpus carried forward.
 */
export const SUMMARY_MIN_CHARS = 1;

/**
 * Upper bound on an accepted branch-A summary, applied AFTER redaction — the
 * bound has to describe the bytes actually stored, not the raw model text.
 *
 * Deliberately the same 4000 as the repo storage backstop
 * (`MAX_SUMMARY_CHARS`) and the same bound the legacy agent-authored compact
 * argument carried, because this value lands in the same sink and is re-sent
 * on every subsequent inference.
 */
export const SUMMARY_MAX_CHARS = 4_000;

/**
 * Next poll delay with jitter. Exported so a test can assert the bound rather
 * than the sample.
 */
export function nextPollDelayMs(
  baseMs: number,
  random: () => number = Math.random,
): number {
  return Math.round(baseMs * (1 + POLL_JITTER_RATIO * random()));
}
