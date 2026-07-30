/**
 * The approved dispatch's ONE pre-dispatch transaction: the operator-stop gate
 * and the dispatch-slot claim, committed together.
 *
 * ## Why they are one transaction and not two
 *
 * They used to be two: `casMarkDispatching` committed on its own, the tool
 * context was hydrated, and only then did `gateOnOperatorStopTransaction` open
 * a second transaction under the session control lock. Both writes were
 * individually correct, but the gap between them was a window — a Stop
 * committing inside it was observed (so the gate refused the dispatch), while a
 * compaction cutover reading money state in that same gap could see the row in
 * neither `not_started` nor `dispatching` consistently with the gate's view.
 *
 * Folding the claim into the gate's existing transaction removes the window at
 * no cost: the session control lock is already taken there, and this module
 * adds no second lock acquisition. It is also what makes this writer a
 * participant in the compaction safe-moment gate (contract C7) — see
 * `db/repos/approval-intents/money-state.ts` for why a reader under the lock
 * proves nothing unless the writers take it too.
 *
 * ## Order inside the transaction is the global lock order, unchanged
 *
 * `session control lock → open control requests → mission_runs row →
 * approval_intents row` (see `lease-and-status/session-control-lock.ts`). So
 * the gate runs FIRST and the CAS second, never the reverse: taking the
 * `approval_intents` row before the control-request rows is exactly the
 * out-of-order acquisition the lock-order documentation forbids.
 *
 * ## The CAS runs even when the gate says `stopped`
 *
 * Deliberately, and it is not a leftover. `abandonDispatchAfterOperatorStop`
 * settles the claimed row through `commitDispatchFailureToolResult`, whose repo
 * write is fenced on `execution_status = 'dispatching'`. Skipping the claim on
 * the stopped path would leave the intent `not_started` — which the reconciler
 * reads as "still dispatchable" and would hand to a dispatcher AFTER the
 * operator's Stop. Claiming it and then settling it is what closes that door,
 * and it is byte-identical to the behaviour of the previous two-transaction
 * shape.
 *
 * ## Nothing external happens here
 *
 * DB only, and it COMMITS before `dispatchTool` runs. Holding the session
 * control lock across a provider or wallet call would block the operator's own
 * Stop — the exact inversion the lock exists to prevent.
 */

import type { PoolClient } from "pg";

import * as approvalIntentsRepo from "../../../../../db/repos/approval-intents.js";
import { withTransaction } from "../../../../../db/client.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
  type OperatorStopGate,
} from "@vex-agent/engine/runtime/lease-and-status.js";

export interface DispatchSlotGateInput {
  readonly approvalId: string;
  readonly sessionId: string;
  readonly missionRunId: string | null;
}

export interface DispatchSlotGateOutcome {
  /**
   * `false` means another writer already owns this dispatch. The caller MUST
   * NOT dispatch the tool — this is the single guard that keeps an approved
   * money-path action from executing twice.
   */
  readonly tookSlot: boolean;
  /** `stopped` suppresses the dispatch, whatever the gate's scope. */
  readonly stopGate: OperatorStopGate;
}

/**
 * Take the operator-stop gate and the dispatch slot in ONE short, DB-only
 * transaction under the session control lock.
 */
export async function claimDispatchSlotUnderStopGate(
  input: DispatchSlotGateInput,
): Promise<DispatchSlotGateOutcome> {
  return withTransaction(async (client: PoolClient) => {
    await acquireSessionControlLock(client, input.sessionId);

    const stopGate = await gateOnOperatorStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: input.missionRunId,
    });

    const tookSlot = await approvalIntentsRepo.casMarkDispatchingWith(
      client,
      input.approvalId,
    );

    return { tookSlot, stopGate };
  });
}
