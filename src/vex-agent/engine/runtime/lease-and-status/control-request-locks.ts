/**
 * The canonical control-request row lock — the ONE place that defines the
 * lock ORDER every stop-capable transaction obeys.
 *
 * Global lock order (non-negotiable):
 *   0. the SESSION CONTROL LOCK (`session-control-lock.ts`) — the advisory
 *      lock that exists even when no row does, so a `stop_terminal` INSERT
 *      can be ordered against a decision that must observe it;
 *   1. every OPEN (`pending` | `observed`) `runtime_control_requests` row for
 *      the session, ordered `(created_at ASC, id ASC)`;
 *   2. the `mission_runs` row.
 *
 * Step 0 is always taken FIRST, so it can never form the second edge of a
 * cycle with steps 1–2 and cannot deadlock against this scheme. The argument
 * below for steps 1–2 is unchanged by its addition.
 *
 * Both stop paths — the iteration-boundary observer (`observe-and-apply.ts`)
 * and the shared stop body (`apply-user-stop.ts`) — acquire step 1 through
 * THIS function, with the identical predicate and the identical ORDER BY, and
 * neither takes a request lock after the run lock. Identical acquisition order
 * over an identical row set makes a lock cycle between two concurrent stop
 * transactions unrepresentable.
 *
 * Why the predicate carries no `kind` filter: two transactions that lock
 * DIFFERENT subsets of the same table can still interleave into a cycle. The
 * set has to be the same on every path, so it is "all open requests for the
 * session" and the per-kind selection happens in memory afterwards.
 *
 * Why this replaced `FOR UPDATE SKIP LOCKED LIMIT 1` in the observer: skipping
 * locked rows let observer A hold request R1 while observer B held R2; each
 * then locked the run and each then needed the OTHER's request row inside the
 * shared stop body — a real deadlock (Codex Wave-1 review, defect 5). Two
 * observers on one session now serialize instead, which is what a stop path
 * should do anyway: the transaction is short, holds no lease and makes no
 * provider call.
 */

import type { PoolClient } from "pg";
import { queryWith } from "../../../db/client.js";
import type { ControlRequestRow } from "./_row-shapes.js";

/** Reason stamped on a control request that could not be proven to target this run. */
export const STALE_CONTROL_REQUEST_REASON = "stale_run_mismatch";

/**
 * Lock every open control request for the session, in the canonical order.
 * MUST be the first lock a stop-capable transaction takes.
 */
export async function lockOpenControlRequests(
  client: PoolClient,
  sessionId: string,
): Promise<readonly ControlRequestRow[]> {
  return queryWith<ControlRequestRow>(
    client,
    `SELECT id, session_id, mission_run_id, kind, status, requested_by,
            reason, correlation_id, created_at, observed_at,
            cleared_at, expires_at
       FROM runtime_control_requests
      WHERE session_id = $1
        AND status IN ('pending', 'observed')
      ORDER BY created_at ASC, id ASC
      FOR UPDATE`,
    [sessionId],
  );
}
