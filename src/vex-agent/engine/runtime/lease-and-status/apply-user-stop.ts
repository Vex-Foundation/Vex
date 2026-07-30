/**
 * `applyUserStop` — the ONE idempotent transaction that lands an operator
 * "Stop" on a mission run.
 *
 * Three callers race for it and MUST leave identical state:
 *   - the observer path (`observeAndApplyControl`) when the live loop reads
 *     the queued `stop_terminal` request at its next iteration boundary;
 *   - the finalize-after-local-abort path (`finalizeMissionRunStatus`) when
 *     the in-process `AbortController` fired first and the loop unwound
 *     before the observer ever ran;
 *   - the direct abort path (`abortMissionRun`) for a paused run or a
 *     `running` run whose lease is dead, where no runner would ever observe
 *     a queued request.
 *
 * Canonical user-stop terminal state — the same on every path:
 *   `mission_runs.status = 'stopped'`, `stop_reason = 'user_stopped'`
 *   `missions.status     = 'cancelled'`
 * Consumers must classify through the status SETS in `engine/types.ts`
 * (`TERMINAL_RUN_STATUSES` and friends), never by comparing to a literal.
 *
 * Run scoping: a `stop_terminal` request names the run it was minted for.
 * This transaction consumes ONLY the requests naming the run it is stopping.
 * A request naming a DIFFERENT run is left untouched — it may be a perfectly
 * valid pending stop for a later run, and a delayed finalizer for run A
 * erasing run B's stop is exactly the bug class run scoping exists to
 * eliminate (Codex Wave-1 review, defect 6). Clearing a request that cannot
 * be proven to target an active run is the observer's job
 * (`observe-and-apply.ts`), which decides it against the run whose checkpoint
 * it is actually running on.
 *
 * Lock order is SESSION CONTROL LOCK → OPEN CONTROL REQUESTS → RUN on every
 * path; the request lock is acquired exactly once, through
 * `lockOpenControlRequests`, and never re-acquired after the run lock. See
 * `control-request-locks.ts` for the row-lock deadlock-freedom argument and
 * `session-control-lock.ts` for why a row lock alone cannot serialize a stop
 * that has not been INSERTED yet.
 */

import type { PoolClient } from "pg";
import {
  executeWith,
  queryOneWith,
  queryWith,
  withTransaction,
} from "../../../db/client.js";
import { TERMINAL_RUN_STATUSES, type MissionRunStatus } from "../../types.js";
import * as approvalsRepo from "../../../db/repos/approvals.js";
import * as missionRunsRepo from "../../../db/repos/mission-runs.js";
import * as missionsRepo from "../../../db/repos/missions.js";
import type { ControlRequestRow } from "./_row-shapes.js";
import { lockOpenControlRequests } from "./control-request-locks.js";
import { acquireSessionControlLock } from "./session-control-lock.js";

/** Stop evidence carried onto the run row — same shape the turn loop produces. */
export interface UserStopPayload {
  readonly summary?: string;
  readonly evidence?: Record<string, unknown>;
}

export interface ApplyUserStopInput {
  readonly sessionId: string;
  /** The run the caller intends to stop — the run-scoping anchor. */
  readonly missionRunId: string;
  readonly stopPayload?: UserStopPayload;
  /**
   * Open control-request rows the CALLER already locked with
   * `lockOpenControlRequests` inside THIS transaction. The observer passes
   * them so the canonical request lock is taken exactly once, before the run
   * lock. Re-acquiring it here (after the observer's run lock) is what
   * inverted the documented lock order and made two concurrent observers
   * deadlockable.
   */
  readonly lockedRequests?: readonly ControlRequestRow[];
}

export type ApplyUserStopOutcome =
  | {
    readonly outcome: "stopped";
    /**
     * THIS transaction performed the non-terminal → terminal transition.
     *
     * That is the only fact distinguishing the winner, because every stop
     * path writes the SAME `stopped`/`user_stopped` pair — the resulting
     * status value cannot tell you who wrote it. The run row is read
     * `FOR UPDATE` and re-checked against `TERMINAL_RUN_STATUSES` inside
     * this transaction, and a terminal row is immutable, so exactly one
     * transaction can ever observe the run non-terminal and move it. A
     * caller that needs "did I win?" (the stop-for-edit mission demotion)
     * must gate on this discriminator, never on the status it reads back.
     */
    readonly previousStatus: MissionRunStatus;
    readonly missionId: string;
    readonly rejectedApprovals: number;
    readonly wakeCancelledCount: number;
    readonly consumedRequests: number;
  }
  | {
    readonly outcome: "already_terminal";
    /** Someone else committed the transition first — this call wrote nothing. */
    readonly currentStatus: MissionRunStatus;
    readonly missionId: string;
    readonly consumedRequests: number;
  }
  | {
    readonly outcome: "run_not_found";
    readonly consumedRequests: number;
  };

interface StoppableRunRow {
  readonly id: string;
  readonly mission_id: string;
  readonly status: MissionRunStatus;
}

/**
 * Consume the open `stop_terminal` requests that name THE RUN BEING STOPPED.
 *
 * Their intent is being applied right now, so clearing them is what makes the
 * whole transaction idempotent: a second caller finds nothing left to observe.
 *
 * Requests naming a DIFFERENT run (or naming none) are deliberately NOT
 * touched. A delayed finalizer for run A must never erase a valid pending
 * stop for a later run B — on a runtime that moves real funds, silently
 * dropping an operator's stop is the worst possible outcome. Requests that
 * can never be applied are retired by the observer's run-scope gate instead,
 * which evaluates them against the run whose checkpoint is actually executing.
 *
 * Operates on the already-locked row set so no lock is taken after the run
 * lock (see the module header's lock order).
 */
async function consumeStopRequestsForRun(
  client: PoolClient,
  openRequests: readonly ControlRequestRow[],
  missionRunId: string,
): Promise<number> {
  let consumed = 0;
  for (const row of openRequests) {
    if (row.kind !== "stop_terminal") continue;
    if (row.mission_run_id !== missionRunId) continue;
    await executeWith(
      client,
      `UPDATE runtime_control_requests
          SET status     = 'cleared',
              cleared_at = NOW()
        WHERE id = $1`,
      [row.id],
    );
    consumed++;
  }
  return consumed;
}

/**
 * Reject the session's pending approvals inside the stop transaction.
 *
 * `approval_queue` carries no `mission_run_id` (see
 * `core/runner/approvals-cleanup.ts`), so session scoping is the established
 * safe boundary: after a stop, no pending approval for the session may still
 * be approvable. The locked SELECT lives here because the approvals repo
 * exposes no client-aware "pending for session" read; the CAS write still
 * goes through `approvalsRepo.rejectWith`, so the reject semantics stay
 * owned by the repo.
 */
export async function rejectPendingApprovalsWithClient(
  client: PoolClient,
  sessionId: string,
): Promise<number> {
  const rows = await queryWith<{ id: string }>(
    client,
    `SELECT id FROM approval_queue
      WHERE session_id = $1 AND status = 'pending'
      ORDER BY created_at ASC
      FOR UPDATE`,
    [sessionId],
  );
  let rejected = 0;
  for (const row of rows) {
    const item = await approvalsRepo.rejectWith(client, row.id);
    if (item !== null) rejected++;
  }
  return rejected;
}

/**
 * Transaction body. Callers that already own a transaction (the observer
 * path) call this directly so the observe and the apply share one commit.
 */
export async function applyUserStopWithClient(
  client: PoolClient,
  input: ApplyUserStopInput,
): Promise<ApplyUserStopOutcome> {
  // Lock order: SESSION CONTROL LOCK → OPEN CONTROL REQUESTS → RUN (see
  // module header). The advisory lock is re-entrant, so taking it here is a
  // no-op when a caller (the observer, the pre-dispatch gate) already holds
  // it, and it is what serializes this transaction against a `stop_terminal`
  // row that has not been inserted yet.
  await acquireSessionControlLock(client, input.sessionId);

  // The observer already holds the canonical request lock and hands its rows
  // in, so that lock is acquired exactly once per transaction, always before
  // the run.
  const openRequests = input.lockedRequests
    ?? await lockOpenControlRequests(client, input.sessionId);

  const consumedRequests = await consumeStopRequestsForRun(
    client,
    openRequests,
    input.missionRunId,
  );

  const run = await queryOneWith<StoppableRunRow>(
    client,
    `SELECT id, mission_id, status FROM mission_runs WHERE id = $1 FOR UPDATE`,
    [input.missionRunId],
  );
  if (run === null) {
    return { outcome: "run_not_found", consumedRequests };
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    // Idempotent: the stop already landed (or the run ended some other way).
    // This run's requests are consumed above, so nothing can re-apply it.
    return {
      outcome: "already_terminal",
      currentStatus: run.status,
      missionId: run.mission_id,
      consumedRequests,
    };
  }

  const rejectedApprovals = await rejectPendingApprovalsWithClient(
    client,
    input.sessionId,
  );

  const wakeCancelledCount = await executeWith(
    client,
    `UPDATE loop_wake_requests
        SET status           = 'cancelled',
            cancelled_at     = NOW(),
            cancelled_reason = 'consumed_by_stop'
      WHERE session_id = $1 AND status = 'pending'`,
    [input.sessionId],
  );

  await missionRunsRepo.updateStatus(
    input.missionRunId,
    "stopped",
    "user_stopped",
    input.stopPayload,
    client,
  );
  // `MissionStatus` has no `stopped` arm — `cancelled` is the mission-level
  // terminal for an operator stop, unchanged from the pre-alignment behavior.
  await missionsRepo.setStatus(run.mission_id, "cancelled", client);

  // Release any lease so a future run can claim the session. The stop is
  // terminal, so no runner may keep the claim.
  await executeWith(
    client,
    `DELETE FROM runner_leases WHERE session_id = $1`,
    [input.sessionId],
  );

  return {
    outcome: "stopped",
    previousStatus: run.status,
    missionId: run.mission_id,
    rejectedApprovals,
    wakeCancelledCount,
    consumedRequests,
  };
}

/** Open a transaction and apply the stop. For callers without one. */
export async function applyUserStopTransaction(
  input: ApplyUserStopInput,
): Promise<ApplyUserStopOutcome> {
  return withTransaction((client) => applyUserStopWithClient(client, input));
}
