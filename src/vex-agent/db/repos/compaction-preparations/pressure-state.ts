/**
 * The storage-side implementation of the per-turn pressure read.
 *
 * IMPORT DIRECTION — read this before adding another engine import here. This
 * file, alone in the repo module, imports a type from
 * `engine/core/preparation-pressure-state.ts`. That is sanctioned and narrow:
 * that module is pure, dependency-free, and explicitly defined as the seam the
 * preparation repo implements against, and it is a TYPE-only import with no
 * runtime edge. It is NOT a licence to reach into the engine generally — the
 * post-commit bus events, in particular, stay with the engine callers precisely
 * so the repo never depends on engine runtime.
 *
 * THE FOUR-VARIANT MAPPING. The union deliberately makes "ready but out of
 * attempts" and "failed with a live lease" unrepresentable, so this function
 * has to decide which storage states bear on pressure at all:
 *
 *   no row, `applied`, `superseded`     → `none`
 *       An applied preparation already relieved the pressure; a superseded one
 *       was replaced. Neither is going to produce anything further, so neither
 *       may hold the barrier open.
 *   `preparing`                         → `preparing`
 *       Carries the live-lease and attempts-remaining evidence the bypass
 *       decision needs. Both are computed here, from the row, so the engine
 *       never re-derives "is this lease alive" from a timestamp it read.
 *   `summary_ready`, `apply_requested` → `summary_ready`
 *       A validated summary exists and a cutover is available to force. The
 *       apply machinery reads the real status again under a lock.
 *   `applying`                          → `applying`
 *       NOT collapsed into `summary_ready`, and the distinction is load-bearing.
 *       A consumed request is a cutover already in motion, so forcing an apply
 *       could only fail — and the critical ladder would then fall through to the
 *       deterministic fallback, which bumps `current + 1`: normally the exact
 *       generation this row already froze as its target. Two writers would claim
 *       one generation with different summaries and archives, and apply-crash
 *       recovery could no longer tell which committed. Reported separately, the
 *       ladder DEFERS instead and waits for the cutover (or for its stale lease
 *       to be recovered).
 *   `failed`                            → `failed`
 *       Today's barrier returns and the runtime falls back deterministically.
 *
 * Fail-closed is the ENGINE's guarantee (`resolvePreparationPressureState`
 * catches a throwing read). This function's job is to be accurate, and to throw
 * rather than guess if the row is unintelligible.
 */

import type { PreparationPressureState } from "../../../engine/core/preparation-pressure-state.js";

import { queryOne } from "../../client.js";
import { BRANCH_STALE_THRESHOLD_MS } from "./policy.js";
import { parseStatus } from "./types.js";

interface PressureStateRow {
  id: number;
  status: string;
  lease_alive: boolean;
  attempts_remaining: number;
  attempt_started_epoch_ms: string | null;
}

/**
 * Read the session's compaction-preparation pressure state.
 *
 * `summaryAttemptTimeoutMs` is supplied by the caller rather than read from
 * this module's policy, because the per-attempt CALL deadline belongs to the
 * branch-A worker's policy, not to the lease policy this repo owns. The turn
 * loop binds it once:
 *
 * ```ts
 * (sid) => getLivePreparationPressureState(sid, SUMMARY_CALL_TIMEOUT_MS)
 * ```
 *
 * which also matches the `(sessionId) => Promise<PreparationPressureState>`
 * shape `resolvePreparationPressureState` expects.
 */
export async function getLivePreparationPressureState(
  sessionId: string,
  summaryAttemptTimeoutMs: number,
): Promise<PreparationPressureState> {
  const row = await queryOne<PressureStateRow>(
    `SELECT id,
            status,
            (summary_status = 'running'
             AND summary_locked_by IS NOT NULL
             AND summary_heartbeat_at IS NOT NULL
             AND summary_heartbeat_at > NOW() - ($2::bigint || ' milliseconds')::interval)
              AS lease_alive,
            GREATEST(summary_max_attempts - summary_attempt_count, 0) AS attempts_remaining,
            CASE
              WHEN summary_status = 'running' AND summary_locked_at IS NOT NULL
              -- FLOOR, not a bare ::bigint cast: the cast rounds half-up while
              -- JS truncates sub-millisecond precision, so the two disagree by
              -- 1ms on roughly half of all timestamps.
              THEN FLOOR(EXTRACT(EPOCH FROM summary_locked_at) * 1000)::bigint::text
              ELSE NULL
            END AS attempt_started_epoch_ms
     FROM compaction_preparations
     WHERE session_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT 1`,
    [sessionId, BRANCH_STALE_THRESHOLD_MS],
  );
  if (!row) return { kind: "none" };

  const preparationId = String(row.id);
  switch (parseStatus(row.status, row.id)) {
    case "preparing":
      return {
        kind: "preparing",
        preparationId,
        leaseAlive: row.lease_alive,
        attemptsRemaining: row.attempts_remaining,
        currentAttemptDeadlineMs:
          row.attempt_started_epoch_ms === null
            ? null
            : Number(row.attempt_started_epoch_ms) + summaryAttemptTimeoutMs,
      };
    case "summary_ready":
    case "apply_requested":
      return { kind: "summary_ready", preparationId };
    // NOT `summary_ready`. A consumed request is a cutover in flight, and the
    // critical ladder must defer rather than force an apply that cannot win and
    // then fall through to the deterministic fallback — which would claim the
    // same generation this row already froze as its target. See the `applying`
    // member of `PreparationPressureState`.
    case "applying":
      return { kind: "applying", preparationId };
    case "failed":
      return { kind: "failed", preparationId };
    case "applied":
    case "superseded":
      return { kind: "none" };
  }
}
