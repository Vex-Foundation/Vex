/**
 * The operator-Stop serialization boundary — both sides of it.
 *
 * One responsibility, two directions:
 *
 *   - `enqueueOperatorStopRequest` is the ONLY way a `stop_terminal` request
 *     enters the system. It writes the row under the session control lock, so
 *     the insert is an ordering event every other holder of that lock can
 *     reason about, and refuses to park a stop on a run that is already
 *     terminal.
 *
 *   - `gateOnOperatorStop*` is what a caller runs, under the same lock, right
 *     before it does something irreversible. It answers one question — "has
 *     the operator stopped this run?" — and, when the answer is yes but the
 *     stop has not landed yet, APPLIES it through the shared stop body rather
 *     than leaving a queued request nobody will observe. Two entry points, the
 *     same `WithClient` / `Transaction` split `apply-user-stop.ts` uses: a
 *     caller that already owns a transaction joins it, a caller that does not
 *     gets one.
 *
 * Applying (not merely detecting) is deliberate. A caller that refuses to act
 * usually also gives up the session lease, and a queued stop with no live
 * runner is stranded until the operator clicks Stop a second time — the
 * failure mode `runtime-stop-dispatch.ts` already documents (issue #12).
 * Applying it here reuses `applyUserStopWithClient`, so there is exactly one
 * implementation of what a user stop means; this module only decides WHEN to
 * invoke it.
 *
 * SESSION SCOPE (`missionRunId === null`). This used to short-circuit to
 * `clear` on the reasoning that `stop_terminal` was run-scoped and nothing ever
 * minted one without a run. That stopped being true when a Full-Autonomous
 * agent SESSION gained its own wake-driven continuation: such a slice spends
 * money and can act on-chain with no run row anywhere, so a stop had to be able
 * to name the SESSION. It does now — a `stop_terminal` row with a NULL
 * `mission_run_id` (see `apply-session-stop.ts` for why that shape, and why it
 * needed no migration) — and this gate CONSUMES it, exactly as the run-scoped
 * branch consumes its own. An interactive chat turn is unaffected: no such row
 * is minted for it, so it still gates `clear`.
 *
 * Lock order: this module takes SESSION CONTROL LOCK → OPEN CONTROL REQUESTS →
 * RUN, the canonical prefix documented in `session-control-lock.ts`.
 */

import type { PoolClient } from "pg";
import { executeWith, queryOneWith, withTransaction } from "../../../db/client.js";
import * as controlRequestsRepo from "../../../db/repos/runtime-control-requests.js";
import { INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE } from "../../../db/contracts/approval-lifecycle-predicates.js";
import { OUTSTANDING_USER_FORM_PREDICATE } from "../../../db/contracts/user-form-lifecycle-predicates.js";
import {
  ACTIVE_OR_PAUSED_RUN_STATUSES,
  TERMINAL_RUN_STATUSES,
  type MissionRunStatus,
} from "../../types.js";
import { applySessionStopWithClient } from "./apply-session-stop.js";
import {
  applyUserStopWithClient,
  rejectPendingApprovalsWithClient,
} from "./apply-user-stop.js";
import { lockOpenControlRequests } from "./control-request-locks.js";
import {
  acquireSessionControlLock,
  withSessionControlLock,
} from "./session-control-lock.js";

interface RunStatusRow {
  readonly status: MissionRunStatus;
}

/**
 * Verdict for a caller about to take an irreversible step.
 *
 * `stopped` always means the run row is TERMINAL by the time this returns —
 * either it already was, or this call applied the operator's queued stop. The
 * status is reported so the caller can surface the real one rather than a
 * literal.
 */
export type OperatorStopGate =
  | { readonly kind: "clear" }
  | {
    readonly kind: "stopped";
    readonly runStatus: MissionRunStatus;
    /**
     * Which thing was stopped. `"run"` reports the real `mission_runs` status;
     * `"session"` has no run row and reports the `cancelled` terminal by
     * convention. Callers that surface a status to a human should check this
     * before claiming anything about a run.
     */
    readonly scope: "run" | "session";
  };

export interface OperatorStopGateInput {
  readonly sessionId: string;
  /** `null` for a chat session — see the module header. */
  readonly missionRunId: string | null;
}

/**
 * Has the operator stopped this run? Caller MUST already be inside a
 * transaction that holds the session control lock (`withSessionControlLock`,
 * or `acquireSessionControlLock` on its own client) — without it the answer is
 * a read of the past, which is the whole defect this module exists to close.
 */
export async function gateOnOperatorStopWithClient(
  client: PoolClient,
  input: OperatorStopGateInput,
): Promise<OperatorStopGate> {
  const { missionRunId } = input;

  // Lock order step 1 — the canonical open-request set, before the run row.
  const openRequests = await lockOpenControlRequests(client, input.sessionId);

  if (missionRunId === null) {
    // Session scope: the only requests that can stop this work are the ones
    // naming NO run. A run-scoped request belongs to a run and is not ours.
    const sessionStop = openRequests.find(
      (row) => row.kind === "stop_terminal" && row.mission_run_id === null,
    );
    if (sessionStop === undefined) return { kind: "clear" };
    await applySessionStopWithClient(client, {
      sessionId: input.sessionId,
      lockedRequests: openRequests,
    });
    // There is no run row, so no run status exists to report. `cancelled` is
    // the taxonomy's terminal for "this work is not going to continue" — the
    // same convention this file already uses for a run row that vanished — and
    // `scope` is what a caller reads when it needs to know which it got.
    return { kind: "stopped", runStatus: "cancelled", scope: "session" };
  }

  // Lock order step 2 — the run row.
  const run = await queryOneWith<RunStatusRow>(
    client,
    "SELECT status FROM mission_runs WHERE id = $1 FOR UPDATE",
    [missionRunId],
  );
  // A run row that vanished is as dead as a terminal one; `cancelled` is the
  // taxonomy's terminal for "this run is not going to continue" and keeps the
  // caller on the status SETS instead of a bespoke literal.
  if (run === null) {
    return { kind: "stopped", runStatus: "cancelled", scope: "run" };
  }
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { kind: "stopped", runStatus: run.status, scope: "run" };
  }

  const queuedStop = openRequests.find(
    (row) => row.kind === "stop_terminal" && row.mission_run_id === missionRunId,
  );
  if (queuedStop === undefined) return { kind: "clear" };

  // The operator stopped, but no runner has observed the request yet. Land it
  // now through the ONE shared stop body — hand over the already-locked rows
  // so the request lock is not re-acquired after the run lock.
  await applyUserStopWithClient(client, {
    sessionId: input.sessionId,
    missionRunId,
    lockedRequests: openRequests,
  });
  return { kind: "stopped", runStatus: "stopped", scope: "run" };
}

/**
 * Own-transaction variant, for a caller standing between two commits rather
 * than inside one (the approved-dispatch gate).
 *
 * A session with no run no longer short-circuits: a session-scoped
 * `stop_terminal` is a real row now, so skipping the transaction would skip the
 * only place it can be observed.
 */
export async function gateOnOperatorStopTransaction(
  input: OperatorStopGateInput,
): Promise<OperatorStopGate> {
  return withSessionControlLock(input.sessionId, (client) =>
    gateOnOperatorStopWithClient(client, input),
  );
}

export type EnqueueOperatorStopOutcome =
  | { readonly outcome: "queued"; readonly requestId: string }
  | {
    readonly outcome: "already_terminal";
    readonly runStatus: MissionRunStatus;
  }
  | { readonly outcome: "run_not_found" };

export interface EnqueueOperatorStopInput {
  readonly sessionId: string;
  readonly missionRunId: string;
  readonly correlationId?: string | null;
}

/**
 * Queue a run-scoped `stop_terminal` request for a live runner to observe.
 *
 * Runs as one transaction under the session control lock, so the insert is
 * strictly ordered against every `gateOnOperatorStop` for the same session: a
 * gate that commits first is guaranteed to have already committed the
 * irreversible step it was guarding (and the stop applies after it), and a
 * gate that commits second is guaranteed to SEE this row.
 *
 * The run row is checked under its lock in the same transaction, so a stop is
 * never parked on a run that is already terminal.
 */
export async function enqueueOperatorStopRequest(
  input: EnqueueOperatorStopInput,
): Promise<EnqueueOperatorStopOutcome> {
  return withTransaction(async (client): Promise<EnqueueOperatorStopOutcome> => {
    await acquireSessionControlLock(client, input.sessionId);
    await lockOpenControlRequests(client, input.sessionId);

    const run = await queryOneWith<RunStatusRow>(
      client,
      "SELECT status FROM mission_runs WHERE id = $1 FOR UPDATE",
      [input.missionRunId],
    );
    if (run === null) return { outcome: "run_not_found" };
    if (TERMINAL_RUN_STATUSES.has(run.status)) {
      return { outcome: "already_terminal", runStatus: run.status };
    }

    const request = await controlRequestsRepo.enqueueRequest(
      {
        sessionId: input.sessionId,
        missionRunId: input.missionRunId,
        kind: "stop_terminal",
        requestedBy: "user",
        correlationId: input.correlationId ?? null,
      },
      client,
    );
    return { outcome: "queued", requestId: request.id };
  });
}

export type EnqueueSessionStopOutcome =
  | { readonly outcome: "queued"; readonly requestId: string }
  /** A session-scoped stop was already open — this call added nothing. */
  | { readonly outcome: "already_queued"; readonly requestId: string }
  /**
   * The stop was fully APPLIED by this transaction and NO request was left
   * behind, because the same transaction proved nothing durable or airborne
   * remains to observe one.
   */
  | { readonly outcome: "applied" }
  /**
   * ENGINE-INTERNAL. A non-terminal mission run for this session became visible
   * under the lock, so this session-scoped stop would have named the wrong
   * scope. NOTHING was written; the caller must re-run the RUN-scoped stop path
   * for `missionRunId`. Never surfaced over IPC.
   */
  | {
    readonly outcome: "active_run_exists";
    readonly missionRunId: string;
    readonly runStatus: MissionRunStatus;
  };

export interface EnqueueSessionStopInput {
  readonly sessionId: string;
  readonly correlationId?: string | null;
}

/** Does a live (unexpired) runner lease exist for this session? */
async function hasLiveSessionLease(
  client: PoolClient,
  sessionId: string,
): Promise<boolean> {
  const row = await queryOneWith<{ readonly present: boolean }>(
    client,
    `SELECT TRUE AS present
       FROM runner_leases
      WHERE session_id = $1 AND expires_at >= NOW()
      LIMIT 1`,
    [sessionId],
  );
  return row !== null;
}

/**
 * Does the session still owe approval-lifecycle work? The predicate is the
 * SHARED one from `db/contracts` — the same fact the Stop-availability
 * aggregate reads — so a session whose Stop key was shown for this reason
 * cannot have its stop request retired here.
 */
async function hasIncompleteApprovalLifecycle(
  client: PoolClient,
  sessionId: string,
): Promise<boolean> {
  const row = await queryOneWith<{ readonly present: boolean }>(
    client,
    `SELECT TRUE AS present
       FROM approval_intents
      WHERE session_id = $1
        AND ${INCOMPLETE_APPROVAL_LIFECYCLE_PREDICATE}
      LIMIT 1`,
    [sessionId],
  );
  return row !== null;
}

/**
 * Is an agent turn parked on a user form and still owed an answer?
 *
 * The predicate is the SHARED one — the same fact the Stop-availability
 * aggregate reads and the durable resume floor selects on. A parked form has no
 * run, no lease and no wake, so without this the transaction would prove
 * "nothing will observe a stop request", retire it, and the form's resume would
 * then run a model turn on a stopped session.
 */
async function hasOutstandingUserForm(
  client: PoolClient,
  sessionId: string,
): Promise<boolean> {
  const row = await queryOneWith<{ readonly present: boolean }>(
    client,
    `SELECT TRUE AS present
       FROM token_launch_intents
      WHERE session_id = $1
        AND ${OUTSTANDING_USER_FORM_PREDICATE}
      LIMIT 1`,
    [sessionId],
  );
  return row !== null;
}

/**
 * The newest non-terminal mission run for this session, read under the lock.
 * `FOR UPDATE` so a concurrent run-creation transaction cannot commit between
 * this read and this transaction's own commit.
 */
async function lockActiveRunForSession(
  client: PoolClient,
  sessionId: string,
): Promise<{ readonly id: string; readonly status: MissionRunStatus } | null> {
  return queryOneWith<{ readonly id: string; readonly status: MissionRunStatus }>(
    client,
    `SELECT id, status
       FROM mission_runs
      WHERE session_id = $1
        AND status = ANY($2::text[])
      ORDER BY started_at DESC
      LIMIT 1
      FOR UPDATE`,
    [sessionId, [...ACTIVE_OR_PAUSED_RUN_STATUSES]],
  );
}

/**
 * Queue a SESSION-scoped `stop_terminal` — the operator stopping autonomous
 * work that has no mission run (a Full-Autonomous agent chat slice).
 *
 * One transaction under the session control lock, so the insert is strictly
 * ordered against every `gateOnOperatorStop` for the same session: a gate that
 * commits first already committed the step it was guarding (and this stop
 * applies after it), and a gate that commits second is guaranteed to SEE this
 * row. That includes the continuation scheduler — which is how a Stop cannot
 * race a wake into existence.
 *
 * ## Target scope is REVALIDATED, never a read of the past
 *
 * The caller chose "session scope" from a read taken before this transaction.
 * A `mission_runs` row committed in between would make that choice wrong in the
 * worst possible way: the run-scoped gate matches on `mission_run_id`, so a
 * NULL-scoped row is never found for a run, and the operator's Stop on real
 * money-moving work would do nothing. So the run is re-read HERE, under the
 * lock, and a session-scoped request is never written for a session that has an
 * active run. The caller re-runs the run-scoped path instead.
 *
 * Lock order is the canonical one: SESSION CONTROL LOCK → OPEN CONTROL
 * REQUESTS → RUN. The re-check is the RUN step of that same order.
 *
 * ## The request is retained only if something will OBSERVE it
 *
 * The pending wake is cancelled and the pending approvals rejected in THIS
 * transaction, not in a follow-up: a stop that clears the request but leaves a
 * due wake behind would be undone by the executor moments later.
 *
 * Whether the `stop_terminal` row is then RETAINED is decided by the same
 * transaction, from durable state rather than from an in-process registry:
 *
 *   - a LIVE LEASE, an INCOMPLETE APPROVAL LIFECYCLE, or an OUTSTANDING USER
 *     FORM → something will consult the gate (the pre-slice gate, an iteration
 *     boundary, the approved-dispatch gate, the reconciler's resume, the
 *     launch-form resume), so the request stays OPEN for it to consume;
 *   - NEITHER → this transaction has just proven no durable or airborne work
 *     remains, so no request is created at all. That is what makes "Stop on an
 *     idle session leaves nothing behind" true, and therefore what keeps a
 *     later, unrelated `loop_defer` from being refused by a stop nobody
 *     retired.
 *
 * Idempotent. A second press finds the open row and returns it rather than
 * stacking duplicates the gate would have to consume one by one.
 */
export async function enqueueSessionStopRequest(
  input: EnqueueSessionStopInput,
): Promise<EnqueueSessionStopOutcome> {
  return withTransaction(async (client): Promise<EnqueueSessionStopOutcome> => {
    await acquireSessionControlLock(client, input.sessionId);
    const openRequests = await lockOpenControlRequests(client, input.sessionId);

    const activeRun = await lockActiveRunForSession(client, input.sessionId);
    if (activeRun !== null) {
      return {
        outcome: "active_run_exists",
        missionRunId: activeRun.id,
        runStatus: activeRun.status,
      };
    }

    const existing = openRequests.find(
      (row) => row.kind === "stop_terminal" && row.mission_run_id === null,
    );
    if (existing !== undefined) {
      return { outcome: "already_queued", requestId: existing.id };
    }

    // Apply the parts of a session stop that must land regardless of whether a
    // request row is retained — see the doc comment above.
    await executeWith(
      client,
      `UPDATE loop_wake_requests
          SET status           = 'cancelled',
              cancelled_at     = NOW(),
              cancelled_reason = 'consumed_by_session_stop'
        WHERE session_id = $1 AND status = 'pending'`,
      [input.sessionId],
    );
    await rejectPendingApprovalsWithClient(client, input.sessionId);

    const observable =
      await hasLiveSessionLease(client, input.sessionId)
      || await hasIncompleteApprovalLifecycle(client, input.sessionId)
      || await hasOutstandingUserForm(client, input.sessionId);
    if (!observable) return { outcome: "applied" };

    const request = await controlRequestsRepo.enqueueRequest(
      {
        sessionId: input.sessionId,
        missionRunId: null,
        kind: "stop_terminal",
        requestedBy: "user",
        correlationId: input.correlationId ?? null,
      },
      client,
    );

    return { outcome: "queued", requestId: request.id };
  });
}
