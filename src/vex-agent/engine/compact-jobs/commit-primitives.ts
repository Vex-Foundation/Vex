/**
 * Compact-commit primitives — the locked-transaction steps shared by every
 * compaction cutover.
 *
 * Extracted from `compact-jobs/service.ts` (which remains the public entry
 * point for the LEGACY `executeCompactNow` path) so the compaction-v2 APPLY
 * cutover can reuse the exact same semantics instead of re-deriving them.
 * Re-deriving them is the specific failure this module exists to prevent: two
 * of the three steps below carry an invariant that is invisible from the call
 * site and fatal to get wrong.
 *
 * What lives here is only what has a reason to change shared by BOTH paths:
 *   - the pre-COMMIT retry boundary (`commitAttempted`);
 *   - locking the session row and deriving the next generation;
 *   - replacing the rolling summary + bumping the generation + resetting
 *     `token_count`, which must never be separable.
 *
 * What deliberately stays in `service.ts` is legacy-path-only: the giant-tool
 * fallback, the `compact_jobs` enqueue, the redaction block and the
 * `source_{start,end}_message_id` provenance computation. C6 forbids the APPLY
 * path from touching `compact_jobs` at all.
 *
 * Every function takes an explicit `PoolClient`: these are transaction steps,
 * not standalone operations, and there is no pool-level variant precisely so
 * none of them can be called outside the caller's lock.
 */

import type { PoolClient } from "pg";

import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import logger from "@utils/logger.js";

/**
 * Records whether the transaction reached its `COMMIT` statement.
 *
 * This is the ONLY thing that makes retrying safe, so it is an explicit
 * parameter rather than an inferred condition. See `runWithCommitRetry`.
 */
export interface CommitAttemptTracker {
  commitAttempted: boolean;
}

export interface CommitRetryInput {
  sessionId: string;
  /** Log dimension only — the caller's own source vocabulary. */
  source: string;
  maxAttempts: number;
  backoffMs: number;
}

/**
 * Run `fn` up to `maxAttempts` times — but retry ONLY for failures that
 * happened strictly BEFORE `COMMIT` was issued.
 *
 * Why the boundary is load-bearing: the callee recomputes `nextGen` from a
 * FRESH `SELECT … FOR UPDATE` on every attempt. If the first attempt actually
 * committed and then something threw on the way out, a retry would read the
 * already-bumped generation, bump it AGAIN, archive a SECOND prefix and (on the
 * legacy path) enqueue a SECOND chunking job. `enqueueJob` is idempotent on
 * `(session_id, checkpoint_generation)`, which protects a replay of the SAME
 * generation — it cannot protect a different one. So a post-COMMIT failure must
 * propagate untouched.
 *
 * A pre-COMMIT failure rolled the transaction back and wrote nothing, so
 * replaying it is safe and spares the caller a lost compact exactly when context
 * pressure is critical. These are DATABASE attempts: this path makes no
 * inference call at all.
 *
 * The discriminator is `tracker.commitAttempted`, NEVER the error type.
 */
export async function runWithCommitRetry<T>(
  input: CommitRetryInput,
  fn: (tracker: CommitAttemptTracker) => Promise<T>,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    const tracker: CommitAttemptTracker = { commitAttempted: false };
    try {
      return await fn(tracker);
    } catch (err) {
      if (tracker.commitAttempted || attempt >= input.maxAttempts) {
        throw err;
      }
      logger.warn("compact.commit_retry", {
        sessionId: input.sessionId,
        source: input.source,
        attempt,
        maxAttempts: input.maxAttempts,
        error: err instanceof Error ? err.message : String(err),
      });
      await delay(input.backoffMs);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SessionGenerationLock {
  currentGen: number;
  nextGen: number;
}

/**
 * Lock the session row and read the current generation.
 *
 * MUST be done before selecting a prefix: planning first would let a second
 * compacter plan against a stale transcript and then serialize on the row lock,
 * so its commit would bump a SECOND generation using an obsolete cutoff.
 * Reading messages + planning under the SAME client as this `FOR UPDATE` is
 * what makes the plan/commit pair atomic per session.
 */
export async function lockSessionAndReadGeneration(
  client: PoolClient,
  sessionId: string,
): Promise<SessionGenerationLock> {
  const genRow = await client.query<{ checkpoint_generation: number }>(
    "SELECT checkpoint_generation FROM sessions WHERE id = $1 FOR UPDATE",
    [sessionId],
  );
  const currentGen = genRow.rows[0]?.checkpoint_generation ?? 0;
  return { currentGen, nextGen: currentGen + 1 };
}

export interface ReplaceSummaryInput {
  sessionId: string;
  /** Already redacted by the caller. */
  summary: string;
  nextGen: number;
}

/**
 * Replace the rolling summary and bump the generation in one step.
 *
 * 1. Wholesale REPLACE (not merge) — the full-context summary IS the new
 *    rolling summary. Merge semantics produced telephone-game drift across many
 *    compactions.
 * 2. The generation bump and the `token_count = 0` reset are ONE `UPDATE` and
 *    are exposed as ONE function so they can never be separated: a restart in
 *    the window between commit and the next `executeTurn` must not resume into
 *    a stale-critical band and fire a redundant forced fallback. That `0` is a
 *    deliberate interim lie — the next `executeTurn` writes the real
 *    post-compact prompt size via `sessionsRepo.updateTokenCount`.
 */
export async function replaceRollingSummaryAndBumpGeneration(
  client: PoolClient,
  input: ReplaceSummaryInput,
): Promise<void> {
  await sessionsRepo.setRollingSummary(input.sessionId, input.summary, client);
  await client.query(
    "UPDATE sessions SET checkpoint_generation = $2, token_count = 0 WHERE id = $1",
    [input.sessionId, input.nextGen],
  );
}
