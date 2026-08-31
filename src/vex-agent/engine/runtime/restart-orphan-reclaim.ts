/**
 * Restart-orphan reclaim - the owner of runs left `running` by a dead process.
 *
 * ## The state this exists for
 *
 * A mission run is `running` only while some process holds the session's runner
 * lease (every one of the continuation entry points claims the lease in the
 * same transaction as, or strictly before, the flip to `running` - see
 * `lease-and-status/claim-run-lease.ts` and `core/runner/mission-run.ts`). When
 * the app is killed mid-slice, the row stays `running` forever: nothing in the
 * engine ever revisits it, the composer shows work in progress that no process
 * is doing, and the operator's only route back is a control that refuses
 * because the run "is already running".
 *
 * ## Why RECURRING, not a boot scan
 *
 * The lease outlives the process that died: `runner_leases.expires_at` is
 * stamped NOW() + ttl (5 minutes on every production claim) and nothing deletes
 * it when the process is killed. A scan that ran once at boot would therefore
 * see a LIVE lease for the common case (restart within five minutes) and
 * conclude, correctly for that instant and wrongly for the run, that someone
 * owns it. The reclaim must come back after the lease expires, which is what
 * the recurring handle below is for. It cannot ride the wake worker's
 * supervisor timer either: that timer is cleared the moment the executor starts
 * (`vex-app/src/main/agent/wake-worker.ts`).
 *
 * ## Why a live lease is absolute
 *
 * A run whose session holds an unexpired lease is NEVER reclaimed, at any
 * stage: it is checked in the candidate query, then re-read `FOR UPDATE` inside
 * the reclaim transaction, because the first read is a read of the past. A
 * process that is alive and heartbeating is the authority on its own run; the
 * reclaim's job is only the runs no process speaks for. Such a candidate is not
 * dropped, it is simply revisited on the next pass.
 *
 * ## Transition discipline (per candidate, one transaction)
 *
 *   0. `acquireSessionControlLock` - lock order edge 0, so the decision cannot
 *      interleave with an operator Stop that has not committed yet;
 *   1. `gateOnOperatorStopWithClient` - a queued Stop wins over the reclaim and
 *      is APPLIED here rather than left stranded (the run has no live runner to
 *      observe it, which is precisely the stranding case that gate exists for);
 *   2. locked re-read of the run row (`FOR UPDATE`);
 *   3. locked re-read of the lease row (`FOR UPDATE`);
 *   4. `updateStatusIfRunning` - the EXACT `WHERE status = 'running'` CAS, never
 *      the broad `updateStatusIfNotTerminal`: a third party writing about
 *      someone else's run may only act on the one state it proved.
 *
 * Idempotent by construction: a second pass over an already-reclaimed run finds
 * `paused_error` at step 2 and writes nothing.
 *
 * ## What the reclaim does NOT do
 *
 * It does not resume anything and it takes no lease. Recovery is an operator
 * decision on `mission.retry` (same run), gated there by the session's money
 * state. Reclaiming is only the honest re-labelling of a run nobody is running.
 */

import type { PoolClient } from "pg";

import logger from "@utils/logger.js";
import { query, withTransaction, queryOneWith } from "../../db/client.js";
import { updateStatusIfRunning } from "../../db/repos/mission-runs.js";
import { emitSessionControlState } from "./emit-control-state.js";
import { gateOnOperatorStopWithClient } from "./lease-and-status/operator-stop-boundary.js";
import { acquireSessionControlLock } from "./lease-and-status/session-control-lock.js";
import type { RuntimeStopReason } from "../types/stop-reasons.js";

/**
 * Stop reason persisted on a reclaimed run. `satisfies` rather than a bare
 * literal, so removing the cause from the runtime vocabulary is a compile error
 * here rather than a persisted row nothing can classify.
 */
export const RESTART_ORPHAN_STOP_REASON =
  "restart_orphan" satisfies RuntimeStopReason;

/**
 * User-visible summary. Truthful about all three facts an operator needs: what
 * was interrupted, that nothing is running now, and that the work is not lost.
 * Cause-specific renderer copy is a separate concern; this string is what a
 * surface with no cause mapping still shows, so it stands on its own.
 */
export const RESTART_ORPHAN_SUMMARY =
  "This mission run was interrupted before it could finish - Vex stopped while the run was still in progress. Nothing is running now. Review what completed, then use Recover to continue the run.";

/** Default cadence. Well under the 5 minute lease TTL, cheap (one indexed read). */
const DEFAULT_INTERVAL_MS = 60_000;
/** Candidates parked per pass. A backlog is drained across passes, not in one. */
const DEFAULT_LIMIT = 20;
/**
 * A run is only a candidate once it has been untouched for this long.
 *
 * Not the primary guard (the lease is), but defence in depth against the one
 * shape the lease cannot describe: a lease row that is ABSENT carries no
 * timestamp, so "no lease" alone cannot distinguish a crashed run from a row in
 * the microseconds around a claim. Staleness is a property the run row itself
 * carries, and it never blocks a genuine orphan - it only delays it.
 */
const DEFAULT_MIN_STALE_MS = 60_000;

export type ReclaimOutcome =
  /** Parked to `paused_error` with cause `restart_orphan`. */
  | "reclaimed"
  /** The session holds a live lease. Not an orphan; revisited next pass. */
  | "lease_live"
  /** The run moved off `running` (or vanished) before the CAS. */
  | "not_running"
  /** A queued operator Stop was found and applied instead. */
  | "operator_stopped";

export interface OrphanCandidate {
  readonly runId: string;
  readonly sessionId: string;
  /** Expiry of the (expired) lease row, or null when no lease row exists. */
  readonly leaseExpiresAt: Date | null;
}

export interface ReclaimPassSummary {
  readonly candidates: number;
  readonly reclaimed: number;
  readonly skipped: number;
  readonly failed: number;
}

interface CandidateRow {
  readonly run_id: string;
  readonly session_id: string;
  readonly lease_expires_at: Date | null;
}

/**
 * Runs that LOOK orphaned. Advisory only - every fact here is re-read under the
 * lock before anything is written, so a candidate that goes stale between the
 * two is a skip, never a bad write.
 */
export async function findOrphanCandidates(options: {
  readonly limit: number;
  readonly minStaleMs: number;
}): Promise<readonly OrphanCandidate[]> {
  const rows = await query<CandidateRow>(
    `SELECT mr.id AS run_id, mr.session_id, l.expires_at AS lease_expires_at
       FROM mission_runs mr
       LEFT JOIN runner_leases l ON l.session_id = mr.session_id
      WHERE mr.status = 'running'
        AND (l.session_id IS NULL OR l.expires_at <= NOW())
        AND GREATEST(mr.started_at, COALESCE(mr.last_checkpoint_at, mr.started_at))
              < NOW() - ($1::int * interval '1 millisecond')
      ORDER BY mr.started_at ASC
      LIMIT $2`,
    [options.minStaleMs, options.limit],
  );
  return rows.map((r) => ({
    runId: r.run_id,
    sessionId: r.session_id,
    leaseExpiresAt: r.lease_expires_at,
  }));
}

/**
 * Reclaim ONE candidate under the session control lock. See the module header
 * for the ordered discipline; the outcome names exactly which step refused.
 */
export async function reclaimOrphanedRun(
  candidate: OrphanCandidate,
  now: () => Date = () => new Date(),
): Promise<ReclaimOutcome> {
  const outcome = await withTransaction(
    async (client: PoolClient): Promise<ReclaimOutcome> => {
      await acquireSessionControlLock(client, candidate.sessionId);

      const stopGate = await gateOnOperatorStopWithClient(client, {
        sessionId: candidate.sessionId,
        missionRunId: candidate.runId,
      });
      if (stopGate.kind === "stopped") {
        logger.info("engine.reclaim.operator_stop_applied", {
          runId: candidate.runId,
          sessionId: candidate.sessionId,
          runStatus: stopGate.runStatus,
        });
        return "operator_stopped";
      }

      const run = await queryOneWith<{ status: string }>(
        client,
        "SELECT status FROM mission_runs WHERE id = $1 FOR UPDATE",
        [candidate.runId],
      );
      if (run === null || run.status !== "running") return "not_running";

      const lease = await queryOneWith<{ expires_at: Date }>(
        client,
        "SELECT expires_at FROM runner_leases WHERE session_id = $1 FOR UPDATE",
        [candidate.sessionId],
      );
      const at = now();
      if (lease !== null && lease.expires_at > at) return "lease_live";

      const parked = await updateStatusIfRunning(
        candidate.runId,
        "paused_error",
        RESTART_ORPHAN_STOP_REASON,
        {
          summary: RESTART_ORPHAN_SUMMARY,
          evidence: {
            restartOrphan: {
              detectedAt: at.toISOString(),
              leaseObserved: lease !== null,
              leaseExpiresAt: lease?.expires_at.toISOString() ?? null,
            },
          },
        },
        client,
      );
      // The CAS ran against the row this transaction holds `FOR UPDATE`, so a
      // false here would mean the lock did not hold. Report it rather than
      // counting a write that did not happen.
      return parked ? "reclaimed" : "not_running";
    },
  );

  if (outcome === "reclaimed" || outcome === "operator_stopped") {
    logger.info("engine.reclaim.candidate_settled", {
      runId: candidate.runId,
      sessionId: candidate.sessionId,
      outcome,
    });
    // AFTER the commit - no runner is left to tell the renderer anything, so
    // this is the only notification the reclaimed run will produce. Total by
    // contract; a failed emit costs at most a stale surface.
    await emitSessionControlState(candidate.sessionId, {
      missionRunId: candidate.runId,
    });
  }
  return outcome;
}

export interface ReclaimPassOptions {
  readonly limit?: number;
  readonly minStaleMs?: number;
  readonly now?: () => Date;
  /**
   * Checked between candidates so a shutdown drains promptly instead of working
   * through a full backlog. Never checked mid-candidate: a started reclaim is
   * one transaction and either commits or rolls back on its own.
   */
  readonly shouldContinue?: () => boolean;
}

/** One reclaim sweep. Never throws: a per-candidate failure is counted and logged. */
export async function runRestartOrphanReclaimPass(
  options: ReclaimPassOptions = {},
): Promise<ReclaimPassSummary> {
  const candidates = await findOrphanCandidates({
    limit: options.limit ?? DEFAULT_LIMIT,
    minStaleMs: options.minStaleMs ?? DEFAULT_MIN_STALE_MS,
  });
  let reclaimed = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    try {
      const outcome = await reclaimOrphanedRun(candidate, options.now);
      if (outcome === "reclaimed") reclaimed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error("engine.reclaim.candidate_failed", {
        runId: candidate.runId,
        sessionId: candidate.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { candidates: candidates.length, reclaimed, skipped, failed };
}

// ── Recurring handle ───────────────────────────────────────────────

export interface RestartOrphanReclaimHandle {
  /** Stop the sweeps. Resolves after the in-flight pass (if any) settles. */
  stop(): Promise<void>;
}

export interface StartReclaimOptions extends ReclaimPassOptions {
  readonly intervalMs?: number;
  /** Pass override for tests; production uses `runRestartOrphanReclaimPass`. */
  readonly runPass?: (options: ReclaimPassOptions) => Promise<ReclaimPassSummary>;
}

/**
 * Start the recurring reclaim. SINGLE-FLIGHT by construction: the next timer is
 * armed in the previous pass's `finally`, so a slow pass is never lapped, and
 * `stop()` awaits whatever is in flight. Idempotent - a second `stop()` clears
 * nothing and awaits nothing.
 */
export function startRestartOrphanReclaim(
  options: StartReclaimOptions = {},
): RestartOrphanReclaimHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const runPass = options.runPass ?? runRestartOrphanReclaimPass;

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const passOptions: ReclaimPassOptions = {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.minStaleMs === undefined ? {} : { minStaleMs: options.minStaleMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    shouldContinue: () => !stopped,
  };

  const runOne = async (): Promise<void> => {
    try {
      const summary = await runPass(passOptions);
      if (summary.reclaimed > 0 || summary.failed > 0) {
        logger.info("engine.reclaim.pass", { ...summary });
      }
    } catch (err) {
      logger.error("engine.reclaim.pass_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = runOne().finally(() => {
      inFlight = null;
      if (!stopped) timer = setTimeout(schedule, intervalMs);
    });
  };

  timer = setTimeout(schedule, intervalMs);
  logger.info("engine.reclaim.started", { intervalMs });

  return {
    async stop(): Promise<void> {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (inFlight) {
        try {
          await inFlight;
        } catch {
          // Already logged inside runOne - shutdown must not throw.
        }
      }
      logger.info("engine.reclaim.stopped");
    },
  };
}
