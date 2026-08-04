/**
 * C3b — the `paused_user_form` continuation.
 *
 * WHY THIS EXISTS AND IS NOT THE APPROVAL SEAM.
 *
 * `launch_request_form` cannot "resume like an approval". Verified in the repo,
 * not assumed:
 *   - `turn-loop-tool-batch/approval-stop.ts` ALWAYS enqueues an approval, flips
 *     the run to `paused_approval` and exposes an approval CARD. Path 1's whole
 *     purpose is a form, not a card.
 *   - `dispatchPreparedMission` only executes a continuation the approval
 *     lifecycle already prepared (`approval-runtime/types.ts`) — it is not a
 *     generic wake API.
 * Reusing either would show the very surface this path exists to avoid, or fail
 * to pause at all.
 *
 * So Path 1 parks on its OWN status and resumes through its own claim. The
 * three properties that make it safe:
 *
 *   1. **Exactly once.** The resume claims the run lease and flips
 *      `paused_user_form → running` in ONE transaction under a row lock
 *      (`claimRunLeaseAndFlipToRunning`). A second submit — a double click, a
 *      retried IPC call, a submit racing an expiry sweep — finds the run no
 *      longer in `paused_user_form` and gets `status_mismatch`. It can never
 *      append a second tool result for the same call.
 *   2. **It never hangs.** Cancel and expiry are not "do nothing": they resume
 *      the turn with an HONEST tool result saying the user dismissed the form or
 *      it expired. The model is told what actually happened and moves on, rather
 *      than the run sitting parked forever with an unanswered tool call.
 *   3. **Row + stamp in ONE transaction**, the same invariant
 *      `post-tx/result-message.ts` documents for the approval path: the
 *      transcript row and the caller's durable stamp commit together, so
 *      "resumed with no tool result" is unrepresentable. The stamp is a callback
 *      because the record it stamps (`token_launch_intents`, contract C1) is
 *      owned by another lane — this module owns the MECHANICS, not the table.
 *
 * The session control lock is the FIRST statement of the transaction, per the
 * repo's global lock order.
 */

import type { PoolClient } from "pg";

import { withTransaction } from "../../db/client.js";
import * as missionRunsRepo from "../../db/repos/mission-runs.js";
import { appendMessage } from "../events/index.js";
import {
  acquireSessionControlLock,
  claimRunLeaseAndFlipToRunning,
  gateOnOperatorStopWithClient,
} from "../runtime/lease-and-status.js";
import { createLeaseHandle, type LeaseHandle } from "../runtime/lease-handle.js";
import { releaseLeaseAndEmitControlState } from "../runtime/release-and-emit.js";
import type { MissionRunStatus } from "../types.js";
import { emitToolResultAppended } from "./approval-runtime/post-tx/result-message.js";
import { LEASE_TTL_MS, toIsoNow } from "./approval-runtime/helpers.js";

/** The single status a form continuation may be claimed from. */
export const USER_FORM_RESUME_CLAIMABLE_RUN_STATUSES = [
  "paused_user_form",
] as const satisfies readonly MissionRunStatus[];

/** Why a parked form is being resolved without a successful submit. */
export type UserFormDismissalReason = "dismissed" | "expired";

/** Identity of a parked form. Every field is host-side evidence. */
export interface UserFormContinuationRef {
  readonly sessionId: string;
  /** `null` for a chat session — there is no run to park, only a tool result. */
  readonly missionRunId: string | null;
  /** The tool call the result must answer. Without it the turn cannot close. */
  readonly toolCallId: string;
}

export type UserFormClaimOutcome =
  | {
    readonly outcome: "claimed";
    /**
     * The RUN lease this claim acquired, as a live handle — or `null` for a
     * chat session, which has no run to flip and claims its SESSION lease at
     * dispatch instead.
     *
     * Carried, not dropped. `claimRunLeaseAndFlipToRunning` acquires a real
     * lease, and `resumeMissionRun`'s contract is explicit that the CALLER owns
     * its lifecycle. Discarding it left the row held with no handle to release
     * it and no heartbeat to renew it — the session stayed blocked until the
     * TTL lapsed, and nothing in the process could shorten that.
     */
    readonly leaseHandle: LeaseHandle | null;
  }
  | { readonly outcome: "already_resolved"; readonly currentStatus: string | null }
  | { readonly outcome: "busy" };

/**
 * Park a mission run on `paused_user_form`.
 *
 * Deliberately NOT `paused_approval`, and deliberately no approval row: nothing
 * about this path may produce an approval card. A chat session (no run) parks
 * nothing — the turn simply ends holding the pending call, and the resume below
 * appends its result. Guarded so a user Stop that landed while the tool was
 * drafting the intent is never overwritten — a terminal run stays terminal and
 * the park is silently moot (the drafted intent row simply never gets claimed).
 */
export async function parkRunForUserForm(ref: UserFormContinuationRef): Promise<void> {
  if (ref.missionRunId === null) return;
  await missionRunsRepo.updateStatusIfNotTerminal(
    ref.missionRunId,
    "paused_user_form",
    "user_form_required",
  );
}

/**
 * Claim the parked run exactly once and flip it back to `running`.
 *
 * `already_resolved` is NOT retryable — the form was already submitted,
 * dismissed or expired, and a second result must never be appended.
 * `busy` means a live lease holder owns the session right now; that IS
 * retryable. Collapsing the two would either duplicate a result or give up on a
 * transient conflict, the same distinction `approval-runtime/continuation.ts`
 * insists on.
 */
export async function claimUserFormResume(
  ref: UserFormContinuationRef,
  ownerId: string,
): Promise<UserFormClaimOutcome> {
  // A chat session has no run to flip. Its SESSION lease is claimed at dispatch
  // — the tool result must land whatever else is running, and only the model
  // turn needs the exclusion.
  if (ref.missionRunId === null) return { outcome: "claimed", leaseHandle: null };

  const claim = await claimRunLeaseAndFlipToRunning({
    sessionId: ref.sessionId,
    missionRunId: ref.missionRunId,
    fromStatuses: [...USER_FORM_RESUME_CLAIMABLE_RUN_STATUSES],
    ownerId,
    processKind: "electron_main",
    // Same lease TTL as the approval continuation — a form resume holds the
    // session for the same kind of short, bounded dispatch.
    ttlMs: LEASE_TTL_MS,
  });

  if (claim.outcome === "claimed") {
    return {
      outcome: "claimed",
      leaseHandle: createLeaseHandle({
        lease: claim.lease,
        ownerId,
        ttlMs: LEASE_TTL_MS,
      }),
    };
  }
  if (claim.outcome === "lease_busy") return { outcome: "busy" };
  return { outcome: "already_resolved", currentStatus: claim.currentStatus ?? null };
}

/**
 * Append the form's tool result and stamp the owning record, in ONE
 * transaction. The transcript event is emitted only AFTER the commit.
 *
 * @param stamp runs on THIS transaction. Throw from it to roll the transcript
 *   row back — that is the intended way to refuse a result whose owning record
 *   was already settled by someone else.
 */
export async function commitUserFormToolResult(input: {
  readonly ref: UserFormContinuationRef;
  readonly success: boolean;
  readonly output: string;
  readonly stamp: (client: PoolClient, resultMessageId: number) => Promise<void>;
}): Promise<void> {
  const { ref } = input;
  const metadata = {
    source: "tool" as const,
    messageType: "tool_result" as const,
    visibility: "internal" as const,
    payload: { success: input.success },
  };

  const inserted = await withTransaction(async (client) => {
    // FIRST statement, per the global lock order — this writer serializes with
    // the compaction safe-moment gate exactly as the approval path's does.
    await acquireSessionControlLock(client, ref.sessionId);
    const row = await appendMessage(
      ref.sessionId,
      { role: "tool", content: input.output, toolCallId: ref.toolCallId, timestamp: toIsoNow() },
      metadata,
      { client },
    );
    await input.stamp(client, row.id);
    return row;
  });

  emitToolResultAppended(ref.sessionId, inserted, metadata);
}

/**
 * CLOSE the continuation: retire the operator's Stop, mark the completion, and
 * let the lease go — in the one order that leaves no instant where an open stop
 * request has nobody to observe it.
 *
 * ## The interleaving this exists for
 *
 * Releasing the lease and THEN marking consumption looks harmless and is not.
 * Between those two writes the form is still outstanding by the durable
 * predicate, so a Stop landing there is RETAINED — correctly, at that instant.
 * A moment later the consumption lands, the form leaves the outstanding set,
 * the lease is already gone, and the retained request has lost its only
 * observer. It does not disappear: it sits open until the NEXT thing to consult
 * the gate — a fresh user turn, a `loop_defer`, an approved dispatch — is
 * refused by a stop that was never meant for it.
 *
 * ## The order, and why each step is where it is
 *
 *   1. ONE TRANSACTION under the session control lock, with the lease STILL
 *      HELD: consult the operator-stop gate, then mark the completion. The gate
 *      both observes and APPLIES, so a Stop that landed during the turn is
 *      consumed by this continuation's own closing decision rather than
 *      outliving it. Marking consumption in the same commit means the two facts
 *      can never disagree about whether this continuation is finished.
 *   2. RELEASE the lease, through the chokepoint, after that commit.
 *   3. One FINAL consultation under the lock. Step 2 is not transactional, so a
 *      Stop can land between the commit and the release — retained at that
 *      instant because the lease is still live, and orphaned the moment it is
 *      not. This retires exactly that row.
 *
 * After step 3 the session has no lease, no outstanding form and nothing this
 * continuation owes, so a Stop arriving later is handled by the stop
 * transaction's own retention rule: it proves nothing will observe a request
 * and leaves none behind. The sequence terminates.
 *
 * `consume` runs on THIS transaction — the same callback shape
 * `commitUserFormToolResult` uses, and for the same reason: the record it marks
 * belongs to another lane and this module owns only the mechanics.
 */
export async function closeUserFormContinuation(input: {
  readonly sessionId: string;
  readonly leaseHandle: LeaseHandle | null;
  readonly consume: (client: PoolClient) => Promise<void>;
}): Promise<void> {
  await withTransaction(async (client) => {
    // Lock FIRST, per the global order.
    await acquireSessionControlLock(client, input.sessionId);
    await gateOnOperatorStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: null,
    });
    await input.consume(client);
  });

  if (input.leaseHandle !== null) {
    await releaseLeaseAndEmitControlState(input.leaseHandle, input.sessionId);
  }

  // The release window. Cheap and idempotent: a session with nothing queued
  // reports `clear` and writes nothing.
  await withTransaction(async (client) => {
    await acquireSessionControlLock(client, input.sessionId);
    await gateOnOperatorStopWithClient(client, {
      sessionId: input.sessionId,
      missionRunId: null,
    });
  });
}

/**
 * The honest tool result for a form the user dismissed, or one that expired.
 *
 * Phrased as fact, not as failure: the model must not conclude the tool is
 * broken and retry it in a loop, nor claim the user approved something they
 * declined. It says who did what.
 */
export function userFormDismissalOutput(reason: UserFormDismissalReason): string {
  return reason === "dismissed"
    ? "The user dismissed the form without submitting it. Nothing was created and no funds moved. " +
        "Do not reopen the form unless the user asks again — treat this as a declined request."
    : "The form expired before the user submitted it. Nothing was created and no funds moved. " +
        "Ask the user whether they still want to proceed before opening it again.";
}
