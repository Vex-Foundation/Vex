/**
 * User-form park — the single transaction that stops a turn on a human form,
 * plus the post-commit dialog push (§C3b).
 *
 * Sibling of `./approval-stop.ts` in every respect that matters, because the
 * problem is the same one: a tool call whose answer arrives later, out of band,
 * from a human. The orchestrator owns the ORDER (dispatch → executedCalls.push
 * → THIS → break); this module owns the transaction body and the emit, so the
 * park and the operator-stop gate cannot drift from the approval precedent.
 *
 * WHY THE STOP GATE IS INSIDE THE TRANSACTION. The operator can press Stop while
 * the handler is still drafting the intent. A run that is already terminal — or
 * carries a queued `stop_terminal` that has not been applied yet — must not be
 * parked on `paused_user_form`: that leaves a form open on a run nobody will
 * ever resume, and the agent never returns to answer its own call. The session
 * control lock is the boundary that makes the check meaningful, exactly as
 * `enqueueApprovalIntent` documents.
 *
 * The intent row is NOT written here. It already exists — the handler makes the
 * wait durable before it returns `pendingUserForm`, because a park with no row
 * to resume against is a hang. This module only decides whether that drafted
 * form gets shown and waited on.
 */

import type { EngineContext } from "../../types.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";
import { withTransaction } from "@vex-agent/db/client.js";
import {
  acquireSessionControlLock,
  gateOnOperatorStopWithClient,
} from "@vex-agent/engine/runtime/lease-and-status.js";
import { emitLaunchFormRequested } from "@vex-agent/engine/runtime/launch-form-bus.js";
import logger from "@utils/logger.js";

/**
 * `abandoned` is the dead-run arm: the drafted intent is left alone (it expires
 * on its own window) and the caller gives the call a truthful result instead,
 * so the transcript keeps its call/result pairing.
 */
export type UserFormParkOutcome =
  | { readonly kind: "parked" }
  | { readonly kind: "abandoned"; readonly runStatus: string | null };

export async function parkTurnOnUserForm(args: {
  readonly context: EngineContext;
  readonly intentId: string;
}): Promise<UserFormParkOutcome> {
  const { context, intentId } = args;

  const outcome = await withTransaction(async (client): Promise<UserFormParkOutcome> => {
    await acquireSessionControlLock(client, context.sessionId);
    const stopGate = await gateOnOperatorStopWithClient(client, {
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
    });
    if (stopGate.kind === "stopped") {
      logger.warn("engine.user_form.abandoned_terminal_run", {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId,
        intentId,
        runStatus: stopGate.runStatus,
      });
      return { kind: "abandoned", runStatus: stopGate.runStatus };
    }

    // A chat session has no run to park: the turn simply ends holding the
    // pending call, and the resume appends its result. Terminal-safe CAS so a
    // Stop that landed between the gate and here still wins.
    if (context.missionRunId) {
      await missionRunsRepo.updateStatusIfNotTerminal(
        context.missionRunId,
        "paused_user_form",
        "user_form_required",
      );
    }
    return { kind: "parked" };
  });

  // Emit-after-commit, per the bus's binding producer contract: the renderer
  // opens the dialog by RE-READING the intent row, so an emit inside the
  // transaction would race that read to an invisible row.
  //
  // This is now the ONLY way the form reaches the user. The tool output is no
  // longer recorded anywhere (that is the point of the stop), and a chat session
  // produces no run-control event at all.
  if (outcome.kind === "parked") {
    emitLaunchFormRequested({ sessionId: context.sessionId, intentId });
  }
  return outcome;
}
