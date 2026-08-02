/**
 * Deadline watchdog — the agent-INDEPENDENT hard-deadline enforcement path.
 *
 * The loop-boundary enforcer in `core/turn-loop.ts` is correct but reachable
 * only while the turn loop is actually iterating: it compares
 * `loopConfig.missionDeadlineMs` at the TOP of each iteration, before
 * inference. A run parked in any `paused_*` state has no loop iterating, so it
 * never reaches that check until something resumes it. Observed live: a
 * 5-minute box sat in `paused_error` and ran 1h20m wall-clock, with
 * `engine.mission.deadline_enforced` finally firing ~1h15m late on resume.
 *
 * This module closes that gap with a wall-clock sweep hosted on the wake
 * executor's existing timer (`wake/executor.ts`), independent of any inference:
 *
 *   - PARKED runs (`paused_approval` / `paused_wake` / `paused_error` /
 *     `paused_user` / `paused_plan_acceptance`) past their frozen deadline are
 *     stopped outright. No loop is running, so there is nothing to race.
 *   - RUNNING runs are stopped ONLY when the runner lease is dead — a ghost row
 *     whose process died mid-run. A running run with a LIVE lease is left
 *     alone; its own loop boundary is the authority, and yanking the row would
 *     race a live loop.
 *
 * Deadline source: the run's IMMUTABLE `started_at` plus the `durationMinutes`
 * frozen into `contract_snapshot_json` — i.e. `resolveFrozenDeadlineMs` from
 * `mission/mission-deadline.ts`, the SAME resolver the loop-boundary enforcer
 * uses. The two paths cannot disagree about when the box ends, and a live
 * mission edit cannot move an in-flight deadline.
 *
 * Concurrency + idempotency: the stop is one atomic CAS (`casStopPastDeadline`
 * — SELECT … FOR UPDATE, re-check, flip, all in a single tx). Exactly one
 * caller wins. A second sweep pass, a concurrent `/retry` resume, a wake
 * executor claim, or the loop-boundary enforcer all see `null` and become
 * no-ops, so the terminal side-effects below run exactly once per run.
 *
 * Composes with the auto-retry work in 28de53f6: a `paused_error` run may have
 * an auto-retry wake queued. Stopping it without cancelling that wake would let
 * the executor resume a terminal run, so `cancelPendingWakes` +
 * `rejectPendingApprovals` are part of the stop — the same resurrection
 * hygiene `abort.ts` performs.
 *
 * POSITION CLOSING IS OUT OF SCOPE. This watchdog never sells, flattens, or
 * liquidates anything. Deadline-aware position closing is deliberately deferred
 * to a designed prepared-close flow with its own approval story; until that
 * lands, an open bag is SURFACED — flagged in the stop summary and evidence,
 * and snapshotted by `captureMissionFinal`'s `openPositions` capture — so an
 * operator can act on it. Do not add a close/sell dependency to this surface.
 *
 * Pure `sweepMissionDeadlines(now, deps)` with injected deps so tests exercise
 * filtering + stop orchestration with no DB, mirroring `wake/executor.ts`.
 */

import logger from "@utils/logger.js";

import { PAUSED_RUN_STATUSES, type MissionRunStatus } from "../types.js";
import type { MissionRun } from "@vex-agent/db/repos/mission-runs.js";

// ── Deps (injected) ─────────────────────────────────────────────────

export interface DeadlineWatchdogDeps {
  /** Every `running` / `paused_*` run — the sweep's candidate set. */
  listCandidateRuns(): Promise<MissionRun[]>;
  /**
   * The run's frozen hard-deadline epoch (ms), or `null` for "no resolvable
   * box" — fail-open, so a bad `started_at` never manufactures an early stop.
   */
  resolveDeadlineMs(run: MissionRun): number | null;
  /** The session's runner lease (live = `expiresAt` in the future), or null. */
  getLease(sessionId: string): Promise<{ expiresAt: Date } | null>;
  /** Atomic, idempotent claim → terminal `failed` / `deadline_reached`. */
  casStopPastDeadline(
    runId: string,
    fromStatuses: readonly MissionRunStatus[],
    payload: {
      stopReason: "deadline_reached";
      summary?: string;
      evidence?: Record<string, unknown>;
    },
  ): Promise<MissionRunStatus | null>;
  /** Reject the session's still-pending approvals. Returns the count. */
  rejectPendingApprovals(sessionId: string): Promise<number>;
  /** Cancel the session's pending wakes (incl. auto-retry). Returns the count. */
  cancelPendingWakes(sessionId: string): Promise<number>;
  /** Move the parent mission row to `failed` (mirrors finalize). */
  setMissionFailed(missionId: string): Promise<void>;
  /** Close the ledger row — also snapshots the still-open position bag. */
  captureFinal(args: {
    missionId: string;
    runId: string;
    sessionId: string;
    outcome: "failed";
    stopReason: "deadline_reached";
  }): Promise<void>;
  /** Broadcast the post-finalize control state to the renderer. */
  emitControlState(sessionId: string, runId: string): Promise<void>;
}

// ── Outcomes (observable for tests / logs / health) ─────────────────

export type DeadlineSweepOutcome =
  | { kind: "stopped"; runId: string; previousStatus: MissionRunStatus }
  | { kind: "skipped_already_terminal"; runId: string }
  | { kind: "skipped_not_due"; runId: string }
  | { kind: "skipped_no_deadline"; runId: string }
  | { kind: "skipped_live_lease"; runId: string }
  | { kind: "error"; runId: string; message: string };

/** Frozen once — the parked arms the CAS may claim from. */
const PARKED_FROM_STATUSES: readonly MissionRunStatus[] = Array.from(
  PAUSED_RUN_STATUSES,
);
const RUNNING_FROM_STATUSES: readonly MissionRunStatus[] = ["running"];

// ── Sweep ───────────────────────────────────────────────────────────

/**
 * One watchdog pass. Returns a per-run outcome so the scheduler, tests, and
 * operators can see exactly what the sweep did. Per-run failures are isolated —
 * one bad row never poisons the rest of the batch.
 */
export async function sweepMissionDeadlines(
  now: Date,
  deps: DeadlineWatchdogDeps,
): Promise<DeadlineSweepOutcome[]> {
  const runs = await deps.listCandidateRuns();
  const outcomes: DeadlineSweepOutcome[] = [];
  for (const run of runs) {
    try {
      outcomes.push(await evaluateRun(run, now, deps));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error("engine.mission.deadline_watchdog.run_failed", {
        missionRunId: run.id,
        sessionId: run.sessionId,
        error: message,
      });
      outcomes.push({ kind: "error", runId: run.id, message });
    }
  }
  return outcomes;
}

async function evaluateRun(
  run: MissionRun,
  now: Date,
  deps: DeadlineWatchdogDeps,
): Promise<DeadlineSweepOutcome> {
  const deadlineMs = deps.resolveDeadlineMs(run);
  if (deadlineMs === null) return { kind: "skipped_no_deadline", runId: run.id };
  if (now.getTime() < deadlineMs) return { kind: "skipped_not_due", runId: run.id };

  // A live loop enforces its own deadline at the turn boundary — only reap a
  // RUNNING row when its lease is dead (a ghost: status says running, the
  // process is gone). Parked rows have no live loop and are always eligible.
  if (run.status === "running") {
    const lease = await deps.getLease(run.sessionId);
    if (lease !== null && lease.expiresAt.getTime() >= now.getTime()) {
      return { kind: "skipped_live_lease", runId: run.id };
    }
  }

  return stopPastDeadline(run, now, deadlineMs, deps);
}

async function stopPastDeadline(
  run: MissionRun,
  now: Date,
  deadlineMs: number,
  deps: DeadlineWatchdogDeps,
): Promise<DeadlineSweepOutcome> {
  const parked = run.status !== "running";
  const fromStatuses = parked ? PARKED_FROM_STATUSES : RUNNING_FROM_STATUSES;

  const openBagNote =
    "Any position this mission opened remains OPEN — it was NOT auto-sold. " +
    "Automatic deadline-time closing is deferred to the prepared-close flow.";
  const summary = parked
    ? `Hard mission deadline reached while parked (${run.status}); stopped by the deadline watchdog. ${openBagNote}`
    : `Hard mission deadline reached on a ghost run (running, lease dead); stopped by the deadline watchdog. ${openBagNote}`;

  // Claim atomically. `null` means another path (a concurrent resume, another
  // sweep, or the loop-boundary enforcer) already moved the row → this pass is
  // a no-op. Do NOT run the terminal side-effects; the winner owns them.
  const previousStatus = await deps.casStopPastDeadline(run.id, fromStatuses, {
    stopReason: "deadline_reached",
    summary,
    evidence: {
      enforcedWhileParked: parked,
      parkedStatus: run.status,
      deadlineMs,
      sweptAt: now.toISOString(),
      overdueMs: now.getTime() - deadlineMs,
      // The bag is SURFACED here, never sold — see the module docstring.
      positionCloseDeferred: true,
      path: "watchdog",
    },
  });
  if (previousStatus === null) {
    return { kind: "skipped_already_terminal", runId: run.id };
  }

  // Resurrection hygiene FIRST, exactly as `abort.ts` does it. A swept
  // `paused_approval` run leaves a pending `approval_queue` row that the UI
  // keeps listing and a later approve would try to resume; a swept
  // `paused_error` run may have an auto-retry wake queued (28de53f6) that the
  // wake executor would otherwise claim. Both would resume a terminal run.
  const rejectedApprovals = await deps.rejectPendingApprovals(run.sessionId);
  const cancelledWakes = await deps.cancelPendingWakes(run.sessionId);

  // Terminal side-effects — mirror `finalizeMissionRunStatus`'s terminate
  // branch for `deadline_reached` (mission row → failed, ledger close, control
  // broadcast). Sequential like finalize; the CAS above is the concurrency gate
  // that guarantees only one sweeper ever reaches here.
  await deps.setMissionFailed(run.missionId);
  await deps.captureFinal({
    missionId: run.missionId,
    runId: run.id,
    sessionId: run.sessionId,
    outcome: "failed",
    stopReason: "deadline_reached",
  });
  await deps.emitControlState(run.sessionId, run.id);

  // Same event name the loop-boundary enforcer logs, with `path` to tell the
  // two apart in the field — which is how the 1h20m overrun was diagnosed.
  logger.info("engine.mission.deadline_enforced", {
    missionRunId: run.id,
    sessionId: run.sessionId,
    deadlineMs,
    previousStatus,
    enforcedWhileParked: parked,
    overdueMs: now.getTime() - deadlineMs,
    rejectedApprovals,
    cancelledWakes,
    path: "watchdog",
  });

  return { kind: "stopped", runId: run.id, previousStatus };
}
