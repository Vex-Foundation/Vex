/**
 * `claimRunLeaseAndFlipToRunning` — atomic helper for resume-style
 * continuation paths (retry, wake handleClaimed, approveAndResume,
 * ingress preempt, IPC requestResume).
 *
 *   1. Lock `mission_runs[id]` `FOR UPDATE`.
 *   2. Validate `currentStatus IN fromStatuses` (else `status_mismatch`).
 *   3. Lock `runner_leases[session_id]` `FOR UPDATE` if present.
 *   4. Validate lease is absent OR expired OR owned by us
 *      (else `lease_busy`).
 *   5. UPDATE mission_runs SET status='running', last_checkpoint_at=NOW().
 *   6. **If `previousStatus === "paused_wake"`**: cancel pending wakes
 *      for this session (consumed_by_resume). Conditional on the
 *      OBSERVED previousStatus, NOT on `fromStatuses.includes(...)`
 *      — a `["paused_error", "paused_wake"]` caller might be flipping
 *      from `paused_error`, in which case the wake row belongs to a
 *      different scheduling cycle and must be left alone (codex v4
 *      acceptance criterion #1).
 *   7. INSERT/UPSERT runner_leases via the same primitive as
 *      `acquireLease` but inside this transaction.
 *
 * One commit; no inter-statement race window.
 */

import type { PoolClient } from "pg";

import {
  withTransaction,
  queryOneWith,
  executeWith,
} from "../../../db/client.js";
import { acquireLease } from "../../../db/repos/runner-leases.js";
import type { ClaimRunInput, ClaimRunOutcome } from "./_types.js";
import {
  type MissionRunRow,
  type RunnerLeaseRow,
  mapLease,
} from "./_row-shapes.js";

export async function claimRunLeaseAndFlipToRunning(
  input: ClaimRunInput,
): Promise<ClaimRunOutcome> {
  return withTransaction(async (client) =>
    claimRunLeaseAndFlipToRunningWith(client, input),
  );
}

/**
 * The same claim, on a transaction the CALLER already owns.
 *
 * Exists for one reason: a caller that must decide something ELSE about this
 * session in the same commit as the claim. The recovery money gate is that
 * caller - it reads the unresolved money state under the session control lock,
 * and while the claim ran in its own later transaction a money writer could
 * commit between the two, so Recover resumed over an outcome nobody had proven.
 * Joining the caller's transaction is what closes that window; two statements
 * cannot be one decision from two transactions.
 *
 * The wrapper above is unchanged for every other caller, so this is a seam and
 * not a second implementation - both run this body. Lock ORDER is the caller's
 * responsibility: the session control lock is taken BEFORE this, never after,
 * matching every other holder of that lock.
 */
export async function claimRunLeaseAndFlipToRunningWith(
  client: PoolClient,
  input: ClaimRunInput,
): Promise<ClaimRunOutcome> {
  {
    // 1. Lock mission_runs row.
    const run = await queryOneWith<MissionRunRow>(
      client,
      `SELECT id, status, session_id FROM mission_runs WHERE id = $1 FOR UPDATE`,
      [input.missionRunId],
    );
    if (run === null) {
      return { outcome: "status_mismatch", currentStatus: null };
    }
    if (!input.fromStatuses.includes(run.status)) {
      return { outcome: "status_mismatch", currentStatus: run.status };
    }
    const previousStatus = run.status;

    // 2. Lock + validate the lease row (if present).
    const existingLease = await queryOneWith<RunnerLeaseRow>(
      client,
      `SELECT session_id, mission_run_id, owner_id, process_kind,
              acquired_at, heartbeat_at, expires_at
         FROM runner_leases
        WHERE session_id = $1
        FOR UPDATE`,
      [input.sessionId],
    );
    if (
      existingLease !== null
      && existingLease.expires_at >= new Date()
      && existingLease.owner_id !== input.ownerId
    ) {
      return { outcome: "lease_busy", currentLease: mapLease(existingLease) };
    }

    // 3. Flip status to running. Bump last_checkpoint_at so the engine's
    //    bridge / observer wake up.
    await executeWith(
      client,
      `UPDATE mission_runs
          SET status = 'running', last_checkpoint_at = NOW()
        WHERE id = $1`,
      [input.missionRunId],
    );

    // 4. Wake cleanup — conditional on the OBSERVED `previousStatus`,
    //    not on the static `fromStatuses` (codex acceptance criterion).
    let wakeCancelledCount = 0;
    if (previousStatus === "paused_wake") {
      wakeCancelledCount = await executeWith(
        client,
        `UPDATE loop_wake_requests
            SET status            = 'cancelled',
                cancelled_at      = NOW(),
                cancelled_reason  = 'consumed_by_resume'
          WHERE session_id = $1
            AND status     = 'pending'`,
        [input.sessionId],
      );
    }

    // 5. Acquire (or refresh) the lease inside the same tx.
    const lease = await acquireLease(
      {
        sessionId: input.sessionId,
        missionRunId: input.missionRunId,
        ownerId: input.ownerId,
        processKind: input.processKind,
        ttlMs: input.ttlMs,
      },
      client,
    );
    // The WHERE clause inside `acquireLease` matches because we already
    // proved the lease is absent / expired / same-owner above (under
    // FOR UPDATE), so `lease` must be non-null here. Throw if it
    // is — that means a schema invariant broke and we shouldn't fake
    // a "claimed" outcome.
    if (lease === null) {
      throw new Error(
        "claimRunLeaseAndFlipToRunning: lease upsert returned null despite passing validation",
      );
    }

    return {
      outcome: "claimed",
      previousStatus,
      lease,
      wakeCancelledCount,
    };
  }
}
