/**
 * `applySessionStop` — the operator "Stop" for a session that has NO mission
 * run: a Full-Autonomous agent chat running a wake-driven slice.
 *
 * ## Why a session-scoped stop had to become a first-class thing
 *
 * `stop_terminal` was born run-scoped, and every consumer of it anchors on a
 * `mission_runs` row. That was sound while the only autonomous work was a
 * mission. It stopped being sound when an agent SESSION gained its own
 * continuation: the wake executor can start a slice, spend money and take
 * on-chain actions with no run row anywhere, and the entire operator-stop
 * surface — the durable request, the gate, the observer — had nothing to bind
 * to. The Stop button reached `runStopDispatch`, found no active run, and
 * returned `no_active_run`. The operator could not stop autonomous work.
 *
 * ## Shape: a `stop_terminal` row with a NULL `mission_run_id`
 *
 * Chosen from repo evidence, not invented. `runtime_control_requests`
 * (migration 022) ALREADY declares `mission_run_id TEXT REFERENCES
 * mission_runs(id)` — nullable, with a partial index that is explicitly
 * `WHERE mission_run_id IS NOT NULL`. The row shape for a session-scoped
 * request already existed and had simply never been minted. So this needs no
 * migration and no new `kind`: the CHECK constraint already admits
 * `stop_terminal`, and the semantics are identical — "the operator wants this
 * work to end, terminally". A new kind would have forced every existing
 * consumer to learn a second spelling of the same intent.
 *
 * It also mirrors the shape used one table over: a session-scoped
 * `loop_wake_requests` row is exactly "the same row with a NULL
 * `mission_run_id`". One rule, two tables, no new vocabulary.
 *
 * ## What a session stop consumes
 *
 * There is no run row to move to `stopped`, so the terminal state lives
 * entirely in what is REMOVED:
 *   - the session-scoped `stop_terminal` requests, cleared (idempotence: a
 *     second caller finds nothing to observe);
 *   - the session's pending approvals, rejected — after a stop no approval may
 *     still be approvable, the same session-scoped boundary the run path uses;
 *   - the pending wake, cancelled — otherwise Stop races the executor into
 *     starting a FRESH slice moments later, which is the whole point of doing
 *     this under the session control lock in ONE transaction.
 *
 * Run-scoped requests (`mission_run_id IS NOT NULL`) are deliberately left
 * alone, the mirror image of the rule in `apply-user-stop.ts`: a stop naming a
 * run is not this transaction's to consume.
 *
 * The in-process AbortController is NOT touched here. Firing a JavaScript
 * signal is not a database effect and is not serialized by the advisory lock;
 * this transaction is the durable, serialized truth, and the caller fires the
 * signal separately as a best-effort latency optimisation.
 */

import type { PoolClient } from "pg";
import { executeWith, withTransaction } from "../../../db/client.js";
import type { ControlRequestRow } from "./_row-shapes.js";
import { rejectPendingApprovalsWithClient } from "./apply-user-stop.js";
import { lockOpenControlRequests } from "./control-request-locks.js";
import { acquireSessionControlLock } from "./session-control-lock.js";

export interface ApplySessionStopInput {
  readonly sessionId: string;
  /**
   * Open control-request rows the CALLER already locked inside THIS
   * transaction, so the canonical request lock is taken exactly once. Same
   * contract as `applyUserStopWithClient`.
   */
  readonly lockedRequests?: readonly ControlRequestRow[];
}

export interface ApplySessionStopOutcome {
  /** Session-scoped `stop_terminal` rows cleared by this transaction. */
  readonly consumedRequests: number;
  readonly rejectedApprovals: number;
  readonly wakeCancelledCount: number;
}

/** Clear the open `stop_terminal` requests that name NO run. */
async function consumeSessionStopRequests(
  client: PoolClient,
  openRequests: readonly ControlRequestRow[],
): Promise<number> {
  let consumed = 0;
  for (const row of openRequests) {
    if (row.kind !== "stop_terminal") continue;
    if (row.mission_run_id !== null) continue;
    await executeWith(
      client,
      `UPDATE runtime_control_requests
          SET status = 'cleared', cleared_at = NOW()
        WHERE id = $1`,
      [row.id],
    );
    consumed++;
  }
  return consumed;
}

/**
 * Transaction body. Callers that already own a transaction (the gate) call this
 * directly so the observe and the apply share one commit.
 */
export async function applySessionStopWithClient(
  client: PoolClient,
  input: ApplySessionStopInput,
): Promise<ApplySessionStopOutcome> {
  // Lock order: SESSION CONTROL LOCK → OPEN CONTROL REQUESTS. No run row
  // exists, so the third step of the canonical order is simply absent — this
  // is a prefix-consistent subset, which is what the order permits. The
  // advisory lock is re-entrant, so taking it here is a no-op for a caller
  // that already holds it.
  await acquireSessionControlLock(client, input.sessionId);
  const openRequests = input.lockedRequests
    ?? await lockOpenControlRequests(client, input.sessionId);

  const consumedRequests = await consumeSessionStopRequests(client, openRequests);
  const rejectedApprovals = await rejectPendingApprovalsWithClient(
    client,
    input.sessionId,
  );

  // The continuation must not survive the stop. Cancelled in the SAME
  // transaction that consumes the request, so the executor cannot claim a due
  // row in between and start a fresh slice on a stopped session.
  const wakeCancelledCount = await executeWith(
    client,
    `UPDATE loop_wake_requests
        SET status           = 'cancelled',
            cancelled_at     = NOW(),
            cancelled_reason = 'consumed_by_session_stop'
      WHERE session_id = $1 AND status = 'pending'`,
    [input.sessionId],
  );

  return { consumedRequests, rejectedApprovals, wakeCancelledCount };
}

/** Open a transaction and apply the session stop. For callers without one. */
export async function applySessionStopTransaction(
  input: ApplySessionStopInput,
): Promise<ApplySessionStopOutcome> {
  return withTransaction((client) => applySessionStopWithClient(client, input));
}
