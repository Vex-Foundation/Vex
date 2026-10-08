/**
 * Stuck-wake repair - re-arms mission runs left in `paused_wake` with no
 * pending wake row.
 *
 * ## The state this exists for
 *
 * The old executor consumed every due mission wake in one batch and started the
 * runs afterwards, one by one. Three things left a run parked with its only
 * wake already consumed and nothing ever looking at it again:
 *
 *   - a crash after the first start (every later row consumed, never started);
 *   - a busy lease at start time (the consumed row was simply dropped);
 *   - a short `LoopDefer` whose wake came due while the run's own turn loop was
 *     still unwinding toward the park (consumed as "stale: running", then the
 *     run parked).
 *
 * The atomic one-at-a-time claim (`executor/claim-mission-wake.ts`) closes all
 * three: `consumed` now commits together with the flip to `running`, so a
 * `paused_wake` run whose latest wake row is `consumed` is exactly the pre-fix
 * shape. This sweep repairs rows already in the database.
 *
 * ## What the repair does, and what it never does
 *
 * It enqueues ONE new pending wake for the run, due now, carrying the lost
 * row's reason and cause plus `repairOf` = the lost row's id. It starts no run,
 * takes no lease, dispatches nothing. The normal executor claims that wake
 * through the same atomic claim as any other, and the resumed runner goes
 * through the ordinary resume path (lease, operator-stop observation, intent
 * reconciliation) before it can do anything. Fund-moving work is never started
 * from here.
 *
 * ## Exactly once
 *
 * Per candidate, one transaction under the session control lock:
 *
 *   0. `acquireSessionControlLock`;
 *   1. `gateOnOperatorStopWithClient` - a queued Stop wins and is applied here,
 *      as the restart-orphan reclaim does, rather than re-arming a stopped run;
 *   2. locked re-read of the run (`paused_wake`, else skip);
 *   3. locked re-read of the lease (a live lease means someone owns it: skip);
 *   4. re-check: no pending wake for the session, the run's latest wake row is
 *      still the same consumed row, it is not itself a repair, and no row
 *      already names it in `repairOf`;
 *   5. INSERT the re-armed row (the partial unique index still allows at most
 *      one pending row per session).
 *
 * Step 4 is what makes it idempotent: a second pass, or a concurrent one
 * serialised behind the lock, sees the pending (or later consumed) repair row
 * and writes nothing. A lost row is repaired at most once, and a repair row is
 * never itself repaired, so the sweep can never become a restart loop.
 */

import type { PoolClient } from "pg";

import logger from "@utils/logger.js";
import { query, queryOneWith, withTransaction } from "../../db/client.js";
import { enqueue } from "../../db/repos/loop-wake.js";
import { emitSessionControlState } from "../runtime/emit-control-state.js";
import { gateOnOperatorStopWithClient } from "../runtime/lease-and-status/operator-stop-boundary.js";
import { acquireSessionControlLock } from "../runtime/lease-and-status/session-control-lock.js";

/** Payload key that links a re-armed wake to the consumed row it replaces. */
export const STUCK_WAKE_REPAIR_KEY = "repairOf";

/** Default cadence and batch. The sweep is one indexed read when nothing is stuck. */
const DEFAULT_INTERVAL_MS = 60_000;
const DEFAULT_LIMIT = 20;
/**
 * A consumed row is only a candidate once it is this old. Not the primary
 * guard (after the atomic claim, `consumed` + `paused_wake` cannot be a
 * transient), but defence in depth for a process still running the old code.
 */
const DEFAULT_MIN_STALE_MS = 60_000;

export type StuckWakeRepairOutcome =
  /** A fresh pending wake now carries the run. */
  | "rearmed"
  /** The run left `paused_wake` (resumed, parked elsewhere) before the lock. */
  | "not_paused_wake"
  /** The session holds a live lease; revisited next pass. */
  | "lease_live"
  /** A pending wake exists, the latest row changed, or it was already repaired. */
  | "not_stuck"
  /** The run is terminal, or a queued operator Stop was found and applied. */
  | "operator_stopped";

export interface StuckWakeCandidate {
  readonly runId: string;
  readonly sessionId: string;
  /** The consumed row whose run never started. */
  readonly lostWakeId: string;
}

export interface StuckWakeRepairSummary {
  readonly candidates: number;
  readonly rearmed: number;
  readonly skipped: number;
  readonly failed: number;
}

interface CandidateRow {
  readonly run_id: string;
  readonly session_id: string;
  readonly lost_wake_id: string;
}

interface LatestWakeRow {
  readonly id: string;
  readonly status: string;
  readonly reason: string | null;
  readonly payload: Record<string, unknown> | null;
}

/**
 * Latest wake row for a run: newest first, id as the tie-break. One spelling,
 * used by the candidate read and the locked re-check.
 */
const LATEST_WAKE_FOR_RUN_SQL = `
  SELECT w.id, w.status, w.reason, w.payload, w.consumed_at
    FROM loop_wake_requests w
   WHERE w.mission_run_id = mr.id
   ORDER BY w.created_at DESC, w.id DESC
   LIMIT 1`;

/**
 * Runs that LOOK stuck. Advisory only: every fact is re-read under the lock
 * before anything is written.
 */
export async function findStuckWakeCandidates(options: {
  readonly limit: number;
  readonly minStaleMs: number;
}): Promise<readonly StuckWakeCandidate[]> {
  const rows = await query<CandidateRow>(
    `SELECT mr.id AS run_id, mr.session_id, latest.id AS lost_wake_id
       FROM mission_runs mr
       JOIN LATERAL (${LATEST_WAKE_FOR_RUN_SQL}) latest ON TRUE
       LEFT JOIN runner_leases l ON l.session_id = mr.session_id
      WHERE mr.status = 'paused_wake'
        AND latest.status = 'consumed'
        AND latest.payload->>'${STUCK_WAKE_REPAIR_KEY}' IS NULL
        AND latest.consumed_at < NOW() - ($1::int * interval '1 millisecond')
        AND (l.session_id IS NULL OR l.expires_at <= NOW())
        AND NOT EXISTS (
          SELECT 1 FROM loop_wake_requests p
           WHERE p.session_id = mr.session_id AND p.status = 'pending')
        AND NOT EXISTS (
          SELECT 1 FROM loop_wake_requests r
           WHERE r.mission_run_id = mr.id
             AND r.payload->>'${STUCK_WAKE_REPAIR_KEY}' = latest.id::text)
      ORDER BY latest.consumed_at ASC
      LIMIT $2`,
    [options.minStaleMs, options.limit],
  );
  return rows.map((r) => ({
    runId: r.run_id,
    sessionId: r.session_id,
    lostWakeId: r.lost_wake_id,
  }));
}

/**
 * The re-armed row's payload: the lost row's structured fields (so the banner
 * still names its cause), minus the claim backoff counter, plus the link.
 */
function repairPayload(lost: LatestWakeRow): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(lost.payload ?? {}) };
  delete rest.claimAttempt;
  return { ...rest, [STUCK_WAKE_REPAIR_KEY]: lost.id };
}

function isRepairRow(row: LatestWakeRow): boolean {
  return row.payload !== null && STUCK_WAKE_REPAIR_KEY in row.payload;
}

/** Re-arm ONE candidate under the session control lock. */
export async function repairStuckWake(
  candidate: StuckWakeCandidate,
  now: () => Date = () => new Date(),
): Promise<StuckWakeRepairOutcome> {
  const outcome = await withTransaction(
    async (client: PoolClient): Promise<StuckWakeRepairOutcome> => {
      await acquireSessionControlLock(client, candidate.sessionId);

      const stopGate = await gateOnOperatorStopWithClient(client, {
        sessionId: candidate.sessionId,
        missionRunId: candidate.runId,
      });
      if (stopGate.kind === "stopped") return "operator_stopped";

      const run = await queryOneWith<{ status: string; session_id: string }>(
        client,
        "SELECT status, session_id FROM mission_runs WHERE id = $1 FOR UPDATE",
        [candidate.runId],
      );
      if (
        run === null
        || run.status !== "paused_wake"
        || run.session_id !== candidate.sessionId
      ) {
        return "not_paused_wake";
      }

      const lease = await queryOneWith<{ expires_at: Date }>(
        client,
        "SELECT expires_at FROM runner_leases WHERE session_id = $1 FOR UPDATE",
        [candidate.sessionId],
      );
      const at = now();
      if (lease !== null && lease.expires_at > at) return "lease_live";

      const pending = await queryOneWith<{ id: string }>(
        client,
        `SELECT id FROM loop_wake_requests
          WHERE session_id = $1 AND status = 'pending' LIMIT 1`,
        [candidate.sessionId],
      );
      if (pending !== null) return "not_stuck";

      const latest = await queryOneWith<LatestWakeRow>(
        client,
        `SELECT latest.id, latest.status, latest.reason, latest.payload
           FROM mission_runs mr
           JOIN LATERAL (${LATEST_WAKE_FOR_RUN_SQL}) latest ON TRUE
          WHERE mr.id = $1`,
        [candidate.runId],
      );
      if (
        latest === null
        || latest.id !== candidate.lostWakeId
        || latest.status !== "consumed"
        || isRepairRow(latest)
      ) {
        return "not_stuck";
      }
      const alreadyRepaired = await queryOneWith<{ id: string }>(
        client,
        `SELECT id FROM loop_wake_requests
          WHERE mission_run_id = $1
            AND payload->>'${STUCK_WAKE_REPAIR_KEY}' = $2
          LIMIT 1`,
        [candidate.runId, latest.id],
      );
      if (alreadyRepaired !== null) return "not_stuck";

      const rearmed = await enqueue(
        {
          sessionId: candidate.sessionId,
          missionRunId: candidate.runId,
          dueAt: at,
          reason: latest.reason,
          payload: repairPayload(latest),
        },
        client,
      );
      // The pending check above ran in this transaction, so a conflict here is
      // a writer that raced it without the session control lock. Nothing was
      // written; report it as not stuck rather than as a repair.
      return rearmed === null ? "not_stuck" : "rearmed";
    },
  );

  if (outcome === "rearmed" || outcome === "operator_stopped") {
    logger.info("wake.repair.candidate_settled", {
      runId: candidate.runId,
      sessionId: candidate.sessionId,
      lostWakeId: candidate.lostWakeId,
      outcome,
    });
    // AFTER the commit, total by contract.
    await emitSessionControlState(candidate.sessionId, {
      missionRunId: candidate.runId,
    });
  }
  return outcome;
}

export interface StuckWakeRepairPassOptions {
  readonly limit?: number;
  readonly minStaleMs?: number;
  readonly now?: () => Date;
  /** Checked between candidates so a shutdown drains promptly. */
  readonly shouldContinue?: () => boolean;
}

/** One repair sweep. Never throws: a per-candidate failure is counted and logged. */
export async function runStuckWakeRepairPass(
  options: StuckWakeRepairPassOptions = {},
): Promise<StuckWakeRepairSummary> {
  const candidates = await findStuckWakeCandidates({
    limit: options.limit ?? DEFAULT_LIMIT,
    minStaleMs: options.minStaleMs ?? DEFAULT_MIN_STALE_MS,
  });
  let rearmed = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of candidates) {
    if (options.shouldContinue && !options.shouldContinue()) break;
    try {
      const outcome = await repairStuckWake(candidate, options.now);
      if (outcome === "rearmed") rearmed += 1;
      else skipped += 1;
    } catch (err) {
      failed += 1;
      logger.error("wake.repair.candidate_failed", {
        runId: candidate.runId,
        sessionId: candidate.sessionId,
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
      });
    }
  }
  return { candidates: candidates.length, rearmed, skipped, failed };
}

// ── Recurring handle ───────────────────────────────────────────────

export interface StuckWakeRepairHandle {
  /** Stop the sweeps. Resolves after the in-flight pass (if any) settles. */
  stop(): Promise<void>;
}

export interface StartStuckWakeRepairOptions extends StuckWakeRepairPassOptions {
  readonly intervalMs?: number;
  /** Pass override for tests; production uses `runStuckWakeRepairPass`. */
  readonly runPass?: (
    options: StuckWakeRepairPassOptions,
  ) => Promise<StuckWakeRepairSummary>;
}

/**
 * Start the recurring repair. Single-flight: the next timer is armed in the
 * previous pass's `finally`, and `stop()` awaits whatever is in flight.
 */
export function startStuckWakeRepair(
  options: StartStuckWakeRepairOptions = {},
): StuckWakeRepairHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const runPass = options.runPass ?? runStuckWakeRepairPass;

  let stopped = false;
  let inFlight: Promise<void> | null = null;
  let timer: NodeJS.Timeout | null = null;

  const passOptions: StuckWakeRepairPassOptions = {
    ...(options.limit === undefined ? {} : { limit: options.limit }),
    ...(options.minStaleMs === undefined ? {} : { minStaleMs: options.minStaleMs }),
    ...(options.now === undefined ? {} : { now: options.now }),
    shouldContinue: () => !stopped,
  };

  const runOne = async (): Promise<void> => {
    try {
      const summary = await runPass(passOptions);
      if (summary.rearmed > 0 || summary.failed > 0) {
        logger.info("wake.repair.pass", { ...summary });
      }
    } catch (err) {
      logger.error("wake.repair.pass_failed", {
        errorClass: err instanceof Error ? err.constructor.name : typeof err,
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
    },
  };
}
