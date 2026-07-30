/**
 * `observeAndApplyControl` — atomic observe + apply for
 * `pause_after_step` / `stop_terminal` control requests. Called from
 * engine safe checkpoints (turn-loop iteration boundary).
 *
 *   0. Take the SESSION CONTROL LOCK (`session-control-lock.ts`) so
 *      this observe+apply is ordered against a `stop_terminal` row
 *      that does not exist yet — a row lock cannot exclude an INSERT.
 *   1. Take the CANONICAL control-request lock for the session
 *      (`lockOpenControlRequests`), then pick the oldest pending
 *      request matching `kinds` from the locked rows. The lock is
 *      taken once, before the run lock, and is never re-taken after
 *      it — that ordering is the whole deadlock-freedom argument and
 *      it lives in `control-request-locks.ts`.
 *   2. RUN-SCOPE GATE: a control request names the run it was minted
 *      for. A request that does not name the run this checkpoint
 *      belongs to is CLEARED as stale and never applied — a stale
 *      request must not be able to pause or terminate a LATER run.
 *   3. Lock that run (if it is still non-terminal).
 *   4. For `pause_after_step`: UPDATE run status='paused_user',
 *      stop_reason='user_paused'. Wake cleanup conditional on
 *      `previousStatus === "paused_wake"`.
 *   5. For `stop_terminal`: delegate to `applyUserStopWithClient` — the
 *      ONE idempotent stop transaction body shared with the
 *      finalize-after-local-abort and direct-abort paths, so whichever
 *      path wins the race leaves identical state.
 *   6. Mark the request `cleared` (the stop path does this itself).
 *
 * Returns the outcome discriminator + previous status + wake count.
 * Event broadcast happens AFTER the surrounding caller acts on the
 * returned outcome (so the bus emits only after commit).
 */

import {
  withTransaction,
  queryOneWith,
  executeWith,
} from "../../../db/client.js";
import { TERMINAL_RUN_STATUSES } from "../../types.js";
import type {
  ObserveControlInput,
  ObserveControlOutcome,
} from "./_types.js";
import {
  type ControlRequestRow,
  type MissionRunRow,
  mapControlRequest,
} from "./_row-shapes.js";
import { applyUserStopWithClient } from "./apply-user-stop.js";
import {
  lockOpenControlRequests,
  STALE_CONTROL_REQUEST_REASON,
} from "./control-request-locks.js";
import { acquireSessionControlLock } from "./session-control-lock.js";

export async function observeAndApplyControl(
  input: ObserveControlInput,
): Promise<ObserveControlOutcome> {
  return withTransaction(async (client) => {
    // 0. Session control lock BEFORE any row lock — the boundary that a
    //    concurrent `stop_terminal` INSERT also passes through.
    await acquireSessionControlLock(client, input.sessionId);

    // 1. Canonical request lock, then pick the oldest pending request of
    //    a kind we handle. Selecting in memory (rather than narrowing the
    //    locked set with SQL) is deliberate: every stop-capable transaction
    //    must lock the SAME row set in the SAME order, or the sets can
    //    interleave into a cycle.
    const openRequests = await lockOpenControlRequests(client, input.sessionId);
    const claimed = openRequests.find(
      (row) => row.status === "pending" && input.kinds.includes(row.kind),
    );
    if (claimed === undefined) {
      return { outcome: "no_request" };
    }

    const observedRow = await queryOneWith<ControlRequestRow>(
      client,
      `UPDATE runtime_control_requests
          SET status      = 'observed',
              observed_at = NOW()
        WHERE id = $1
        RETURNING id, session_id, mission_run_id, kind, status, requested_by,
                  reason, correlation_id, created_at, observed_at,
                  cleared_at, expires_at`,
      [claimed.id],
    );
    if (observedRow === null) {
      throw new Error(
        "observeAndApplyControl: request row vanished between SELECT and UPDATE",
      );
    }
    const request = mapControlRequest(observedRow);

    // 2. RUN-SCOPE GATE. The request carries the `mission_run_id` the IPC
    //    minted it for. Matching by session alone would let a request left
    //    over from an earlier run stop or pause a LATER one — a correctness
    //    bug on a runtime that moves real funds. A mismatch (including a
    //    request that names no run) is cleared as stale, never applied.
    if (request.missionRunId !== input.missionRunId) {
      await executeWith(
        client,
        `UPDATE runtime_control_requests
            SET status     = 'cleared',
                cleared_at = NOW(),
                reason     = COALESCE(reason, $2)
          WHERE id = $1`,
        [request.id, STALE_CONTROL_REQUEST_REASON],
      );
      return { outcome: "stale_cleared", request };
    }

    // 3. Lock the run this checkpoint belongs to. A run that vanished or
    //    already went terminal is treated exactly like "no active run"
    //    below: the request is cleared and no transition is applied.
    const runRow = input.missionRunId === null
      ? null
      : await queryOneWith<MissionRunRow>(
        client,
        `SELECT id, status, session_id
           FROM mission_runs
          WHERE id = $1
          FOR UPDATE`,
        [input.missionRunId],
      );
    const activeRun =
      runRow !== null && !TERMINAL_RUN_STATUSES.has(runRow.status)
        ? runRow
        : null;

    // 4+5. Apply the state transition by kind.
    if (request.kind === "pause_after_step") {
      if (activeRun === null) {
        // No active run to pause — just clear and emit a no-op outcome.
        await executeWith(
          client,
          `UPDATE runtime_control_requests
              SET status     = 'cleared',
                  cleared_at = NOW(),
                  reason     = COALESCE(reason, 'no_active_run')
            WHERE id = $1`,
          [request.id],
        );
        return {
          outcome: "paused_user_applied",
          request,
          previousStatus: "running",
          wakeCancelledCount: 0,
        };
      }
      const previousStatus = activeRun.status;

      await executeWith(
        client,
        `UPDATE mission_runs
            SET status        = 'paused_user',
                stop_reason   = 'user_paused',
                last_checkpoint_at = NOW()
          WHERE id = $1`,
        [activeRun.id],
      );

      let wakeCancelledCount = 0;
      if (previousStatus === "paused_wake") {
        wakeCancelledCount = await executeWith(
          client,
          `UPDATE loop_wake_requests
              SET status            = 'cancelled',
                  cancelled_at      = NOW(),
                  cancelled_reason  = 'consumed_by_pause'
            WHERE session_id = $1 AND status = 'pending'`,
          [input.sessionId],
        );
      }

      await executeWith(
        client,
        `UPDATE runtime_control_requests
            SET status      = 'cleared',
                cleared_at  = NOW()
          WHERE id = $1`,
        [request.id],
      );

      return {
        outcome: "paused_user_applied",
        request,
        previousStatus,
        wakeCancelledCount,
      };
    }

    // stop_terminal
    if (activeRun === null) {
      await executeWith(
        client,
        `UPDATE runtime_control_requests
            SET status     = 'cleared',
                cleared_at = NOW(),
                reason     = COALESCE(reason, 'no_active_run')
          WHERE id = $1`,
        [request.id],
      );
      return {
        outcome: "stop_applied",
        request,
        previousStatus: "running",
        terminalStatus: "stopped",
        wakeCancelledCount: 0,
      };
    }
    const previousStatus = activeRun.status;

    // Shared idempotent stop body: rejects the session's pending approvals,
    // cancels wakes, writes the canonical terminal state
    // (`stopped` / `user_stopped` + mission `cancelled`), releases the lease
    // and clears this request. Identical to what the finalize-after-local-
    // abort and direct-abort paths run, so whichever wins the race the DB
    // ends up in the same place.
    const applied = await applyUserStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: activeRun.id,
      // We already hold the canonical request lock — hand the rows over so the
      // shared body does not re-acquire it AFTER the run lock (the inversion
      // that made two concurrent observers deadlockable).
      lockedRequests: openRequests,
    });

    return {
      outcome: "stop_applied",
      request,
      previousStatus,
      terminalStatus: "stopped",
      wakeCancelledCount:
        applied.outcome === "stopped" ? applied.wakeCancelledCount : 0,
    };
  });
}
