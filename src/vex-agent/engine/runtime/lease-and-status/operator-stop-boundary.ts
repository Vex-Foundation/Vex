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
 * Chat sessions (`missionRunId === null`) always gate `clear`: a
 * `stop_terminal` request is run-scoped and `runStopDispatch` never mints one
 * without an active run. "Stop generating" on a chat turn is the in-process
 * inference abort signal, which the turn loop and the tool batch already
 * observe directly.
 *
 * Lock order: this module takes SESSION CONTROL LOCK → OPEN CONTROL REQUESTS →
 * RUN, the canonical prefix documented in `session-control-lock.ts`.
 */

import type { PoolClient } from "pg";
import { queryOneWith, withTransaction } from "../../../db/client.js";
import * as controlRequestsRepo from "../../../db/repos/runtime-control-requests.js";
import { TERMINAL_RUN_STATUSES, type MissionRunStatus } from "../../types.js";
import { applyUserStopWithClient } from "./apply-user-stop.js";
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
  | { readonly kind: "stopped"; readonly runStatus: MissionRunStatus };

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
  if (missionRunId === null) return { kind: "clear" };

  // Lock order step 1 — the canonical open-request set, before the run row.
  const openRequests = await lockOpenControlRequests(client, input.sessionId);

  // Lock order step 2 — the run row.
  const run = await queryOneWith<RunStatusRow>(
    client,
    "SELECT status FROM mission_runs WHERE id = $1 FOR UPDATE",
    [missionRunId],
  );
  // A run row that vanished is as dead as a terminal one; `cancelled` is the
  // taxonomy's terminal for "this run is not going to continue" and keeps the
  // caller on the status SETS instead of a bespoke literal.
  if (run === null) return { kind: "stopped", runStatus: "cancelled" };
  if (TERMINAL_RUN_STATUSES.has(run.status)) {
    return { kind: "stopped", runStatus: run.status };
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
  return { kind: "stopped", runStatus: "stopped" };
}

/**
 * Own-transaction variant, for a caller standing between two commits rather
 * than inside one (the approved-dispatch gate).
 *
 * A session with no run short-circuits WITHOUT opening a transaction at all:
 * `stop_terminal` is run-scoped, so there is nothing to observe and no reason
 * to make every chat approval pay for a lock round-trip.
 */
export async function gateOnOperatorStopTransaction(
  input: OperatorStopGateInput,
): Promise<OperatorStopGate> {
  if (input.missionRunId === null) return { kind: "clear" };
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
