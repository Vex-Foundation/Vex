/**
 * Compact-jobs worker policy — archive chunking worker constants
 * (heartbeat / stale recovery / retry / per-call timeout), plus the retry
 * budget for the compact COMMIT itself.
 *
 * Two distinct things live here, and conflating them has bitten before:
 *   - the COMPACT COMMIT is synchronous, pure DB work in one transaction
 *     (`compact-jobs/service.ts`) and makes NO inference call;
 *   - the ARCHIVE CHUNKING WORKER is the async outbox consumer
 *     (`compact-jobs/executor.ts`) that DOES call the model.
 * Their retry budgets are therefore unrelated: DB attempts vs provider calls.
 *
 * NOT THE COMPACTION-V2 PIPELINE. The preparation branch workers have their
 * own constants in two places — `db/repos/compaction-preparations/policy.ts`
 * (lease/attempt/stale/backoff, because the SQL CAS predicates depend on them)
 * and `engine/compaction/policy.ts` (poll cadence, call deadlines, summary
 * length bounds). Nothing here is shared with them: this module belongs to the
 * legacy `compact_jobs` chunker, which survives as the deterministic
 * LLM-free-fallback path and is deliberately isolated from that wave.
 *
 * No DB, no embeddings, no I/O. Tested as plain unit tests.
 */

// ── Outbox worker ───────────────────────────────────────────────

/** Worker heartbeat interval (must be < stale threshold). */
export const WORKER_HEARTBEAT_INTERVAL_MS = 20_000;

/** Stale threshold for `running` jobs whose heartbeat has not been updated. */
export const WORKER_STALE_THRESHOLD_MS = 2 * 60_000;

/** Max attempts before a job is marked `permanently_failed`. */
export const WORKER_MAX_ATTEMPTS = 3;

/**
 * Per-LLM-call timeout for the archive chunking worker.
 *
 * 90s, raised from 30s: the OpenRouter client is configured with a backoff
 * retry envelope of `maxElapsedTime: 60000` (`inference/openrouter.ts`), so a
 * 30s deadline guaranteed we cancelled the call while the SDK was still
 * legitimately retrying a transient 429/5xx — the job then failed and burned
 * one of its `WORKER_MAX_ATTEMPTS`. 90s absorbs the whole SDK envelope and
 * still sits well under `WORKER_STALE_THRESHOLD_MS` (120s) with a 20s
 * heartbeat, so an in-flight call can never be mistaken for a dead worker.
 *
 * NOTE (cross-worker): `memory-manager/policy.ts` derives `JUDGE_TIMEOUT_MS`
 * from this constant, so the memory judge and entity extraction move to 90s
 * with it. That alignment is deliberate — one per-call deadline discipline
 * across the background workers — but it IS a behaviour change for those two.
 */
export const CHUNKER_CALL_TIMEOUT_MS = 90_000;

/** Initial retry backoff (multiplied by attempt_count for exponential schedule). */
export const CHUNKER_RETRY_BACKOFF_BASE_MS = 30_000;

// ── Compact commit (synchronous DB transaction) ──────────────────

/**
 * How many times `executeCompactNowInner` may be attempted for ONE compact.
 *
 * These are DATABASE attempts, not provider calls — this path makes no
 * inference call at all. A transient pool/lock/serialization failure before
 * COMMIT leaves nothing written (the transaction rolled back), so replaying it
 * is safe and spares the caller a lost compact at the exact moment context
 * pressure is critical.
 */
export const COMPACT_COMMIT_MAX_ATTEMPTS = 3;

/** Backoff between compact-commit attempts. Short — the caller is blocked. */
export const COMPACT_COMMIT_RETRY_BACKOFF_MS = 500;
