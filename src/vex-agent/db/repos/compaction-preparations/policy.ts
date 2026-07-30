/**
 * Compaction-preparations lease policy — attempt budgets, heartbeat cadence,
 * stale thresholds and retry backoff.
 *
 * These constants live in the REPO, not in the engine, because the DB CAS
 * predicates are written against them: the claim query compares
 * `attempt_count < max_attempts`, the stale sweeps compare `heartbeat_at` to
 * the threshold, and the column DEFAULTs in `058_compaction_preparations.sql`
 * hard-code the same attempt budgets. The workers (engine side) import these;
 * they must never re-declare their own, or a worker's idea of "exhausted" and
 * the row's `max_attempts` default drift apart silently.
 *
 * The numbers deliberately match `engine/compact-jobs/policy.ts` so the legacy
 * fallback chunker and this pipeline do not develop different failure timings.
 *
 * No DB, no I/O — plain constants.
 */

/** Branch-A (summary) LLM attempts before `permanently_failed`. Mirrors the column DEFAULT. */
export const SUMMARY_MAX_ATTEMPTS = 3;

/** Branch-B (chunks) LLM attempts before `permanently_failed`. Mirrors the column DEFAULT. */
export const CHUNKS_MAX_ATTEMPTS = 3;

/**
 * Heartbeat cadence for BOTH branch leases and for the apply lease. Must stay
 * comfortably below every stale threshold below, or a healthy worker gets
 * reclaimed mid-call.
 */
export const BRANCH_HEARTBEAT_INTERVAL_MS = 20_000;

/** A branch lease whose heartbeat is older than this is treated as dead. */
export const BRANCH_STALE_THRESHOLD_MS = 2 * 60_000;

/**
 * An `applying` row whose apply heartbeat is older than this is resolved by
 * `recoverStuckApplying`. Same magnitude as the branch threshold: the cutover
 * transaction is pure DB work and cannot legitimately run for two minutes.
 */
export const APPLY_STALE_THRESHOLD_MS = 2 * 60_000;

/** Base retry backoff; callers multiply by `attemptCount` for an exponential schedule. */
export const BRANCH_RETRY_BACKOFF_BASE_MS = 30_000;

/**
 * Backoff applied when a stale lease is reclaimed. Capped at the stale
 * threshold so recovery never pushes a row further out than the sweep interval.
 */
export const STALE_RECLAIM_BACKOFF_MS = 30_000;

/**
 * Hard upper bound on `summary_output`, enforced before the `summary_ready` CAS
 * is issued. Branch A already validates and redacts its own output; this is the
 * storage-side backstop that keeps a runaway generation out of the rolling
 * summary (which is re-sent on every subsequent inference). Mirrors the 1-4000
 * character contract the legacy agent-authored summary argument carried.
 */
export const MAX_SUMMARY_CHARS = 4000;
