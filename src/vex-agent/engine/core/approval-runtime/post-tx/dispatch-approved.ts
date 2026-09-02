/**
 * Approval runtime — approved-tool dispatch: the single resumed-dispatch path.
 *
 * `applyApproveSideEffects` is the ONLY path that dispatches a tool from the
 * approval runtime. This file owns the ORDER; the steps it orders live in the
 * sibling `dispatch-approved/` folder, one responsibility each:
 *
 *   `operator-stop.ts`       — what a user Stop does to this dispatch, before
 *                              it leaves the runtime and after.
 *   `dispatch-slot-gate.ts`  — the ONE pre-dispatch transaction: stop gate and
 *                              dispatch-slot claim, committed together.
 *   `dispatch-failure.ts`    — making an unhandled dispatch throw durable.
 *   `resumed-tool-context.ts`— the wallet scope an approved tool resumes under.
 *
 * The ORDER is the safety property:
 *
 *   1. claim the continuation (mission lease flip, or chat session lease);
 *   2. build the resumed tool context (reads only, moves nothing);
 *   3. ONE transaction under the session control lock: OPERATOR-STOP GATE,
 *      then CAS `not_started -> dispatching` stamping `dispatch_started_at`;
 *   4. dispatch;
 *   5. commit result + `result_message_id` atomically;
 *   6. apply a Stop queued during the unlocked dispatch, which suppresses the
 *      resume;
 *   7. otherwise hand the continuation back so the agent is resumed.
 *
 * Step 3 is the boundary that stops an approved MUTATING tool from executing
 * after the user pressed Stop. It sits IMMEDIATELY BEFORE `dispatchTool`,
 * because any await between the gate and the call is a window in which a Stop
 * can commit while the tool has still not started — a not-yet-started call is
 * exactly the one the gate exists to refuse. Context construction therefore
 * runs before it; that step only hydrates the session, so nothing has happened
 * yet when the gate lands.
 *
 * The slot CAS is INSIDE that same transaction. The two used to commit
 * separately, with the CAS first, on the reasoning that the CAS commit is the
 * moment this dispatch becomes publicly committed-to — so any stop inserted
 * later necessarily sees `execution_status = 'dispatching'` and is a stop
 * against a call already in flight, which must be allowed to finish since we
 * cannot know whether it already moved funds. That reasoning is unchanged and
 * now holds with NO window at all: gate and claim commit atomically, so a stop
 * is either visible to the gate (which lands it and refuses to dispatch) or
 * strictly after the claim. There is no third interleaving: the gate, the CAS
 * and `enqueueOperatorStopRequest` all pass through the same session advisory
 * lock. Merging them is also what makes this writer a participant in the
 * compaction safe-moment gate — see `dispatch-slot-gate.ts`.
 *
 * That transaction COMMITS BEFORE `dispatchTool` runs. Holding a lock
 * across a provider/wallet call would let a stuck HTTP request block the
 * operator's Stop itself, which is the opposite of the point; the price is
 * that a stop arriving during the dispatch is honoured after it, exactly as
 * the in-flight rule already requires. `applyQueuedOperatorStop` is what
 * honours it: it LANDS the queued stop durably instead of merely logging it.
 *
 * TERMINAL-STOP PRECEDENCE — the second safety property of this module.
 * A terminal user stop outranks every other terminal state, and that has to
 * hold on the failure exits, not only when everything works. Two rules:
 *
 *   a. the dispatch RESULT is committed BEFORE the stop is applied, on every
 *      path. The tool may already have moved funds; that fact is durable
 *      history and must never be lost to a stop that arrived after it.
 *   b. the stop is applied BEFORE any `paused_error` parking decision, and
 *      every parking write here goes through `flipRunToPausedError`, whose
 *      repo CAS refuses to write a terminal row. So once the stop lands, no
 *      failure arm can reopen the run — the ordering and the CAS are two
 *      halves of the same invariant, not two independent guards.
 *
 * Nothing is ever re-dispatched: applying a stop only settles state that
 * already exists.
 *
 * Claim-before-dispatch is the fix for the worst failure this module had: with
 * dispatch first, a busy lease meant the funds had already moved while the IPC
 * reported `dispatch_failed` and the run flipped to `paused_error`. Now a busy
 * lease is observed while nothing has happened yet, so the honest answer is
 * "deferred" and the approval survives as a durable pending resume.
 *
 * The CAS in step 3 is what makes double-dispatch impossible: the scheduled
 * reconciler resolves the same `approved` / `not_started` rows, and exactly one
 * of the two writers can win the transition.
 *
 * Dispatch error categories (Codex puzzle-5 phase-3 review points 1 + 3 + 8):
 *   - controlled (`success:false`)            → tool-result with output,
 *                                               agent resumes via continuation.
 *   - unhandled dispatch throw                → structural tool-result,
 *                                               mission flipped to
 *                                               `paused_error`, continuation
 *                                               discarded, throws
 *                                               `ApprovalDispatchError`.
 *   - post-dispatch persistence failure       → mission flipped to
 *                                               `paused_error`, throws
 *                                               `ApprovalPostDecisionError`.
 *   - lease busy                              → NO dispatch, `deferred_busy`.
 *   - result commit superseded                → the reconciler already called
 *                                               this dispatch `indeterminate`;
 *                                               the commit rolls back so the
 *                                               verdict is not overwritten and
 *                                               no second tool result lands.
 *                                               NO `paused_error` flip.
 *   - run left the resumable statuses         → `paused_error` +
 *                                               `ApprovalPostDecisionError`
 *                                               (not transient — retrying
 *                                               would loop forever).
 *
 * Transcript content for dispatch failures is structural-only (errorKind +
 * errorHash). Raw / redacted error message text is intentionally absent —
 * tool/protocol/wallet errors can carry secrets the agent should not see.
 */

import { dispatchTool } from "../../../../tools/dispatcher.js";
import logger from "@utils/logger.js";

import { claimResumeContinuation, discardContinuation } from "../continuation.js";
import { scheduleDeferredResumeRetries } from "../deferred-resume.js";
import {
  extractToolCall,
  RESULT_SUPERSEDED_ERROR_KIND,
  shortSha256,
  summarizeErrorForLog,
} from "../helpers.js";
import type { ApproveSnapshot } from "../snapshot.js";
import {
  approvalRequestDigestMatches,
  checkApprovalManifestIdentity,
  readApprovalQuoteAuthority,
} from "../tool-call-envelope.js";
import {
  ApprovalDispatchError,
  ApprovalPostDecisionError,
  ApprovalResultSupersededError,
  type ApprovePrepareOutcome,
  type PreparedContinuation,
} from "../types.js";

import { deriveExplorerRefs } from "../../explorer-refs.js";
import { displayStatusPayload } from "../../tool-display-status.js";
import { flipRunToPausedError, RESUME_CLAIM_ERROR_KIND } from "./recovery.js";
import { commitApprovedToolResult } from "./result-message.js";
import { onDispatchThrow } from "./dispatch-approved/dispatch-failure.js";
import {
  abandonDispatchAfterOperatorStop,
  applyQueuedOperatorStop,
  STOP_APPLY_FAILED_ERROR_KIND,
} from "./dispatch-approved/operator-stop.js";
import { buildResumedApprovalToolContext } from "./dispatch-approved/resumed-tool-context.js";
import { claimDispatchSlotUnderStopGate } from "./dispatch-approved/dispatch-slot-gate.js";
import { applyStudioApproveSideEffects } from "./dispatch-approved/studio.js";

type ApprovedDispatchExecutionStatus = "succeeded" | "failed" | "indeterminate";

function isLighterUnresolvedResult(data: unknown): boolean {
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    return false;
  }
  const row = data as Record<string, unknown>;
  if (
    row["source"] === "vex_lighter_live_deposit"
    && (row["status"] === "ambiguous" || row["status"] === "l2_pending")
  ) {
    return true;
  }
  if (row["source"] !== "vex_lighter_live_order_create") return false;
  const status = row["status"];
  const executionState = row["executionState"];
  return (
    status === "ambiguous"
    || status === "sequencer_pending"
    || executionState === "ambiguous"
    || executionState === "sequencer_pending"
  );
}

export function deriveApprovedDispatchExecutionStatus(input: {
  readonly success: boolean;
  readonly data?: Record<string, unknown>;
}): ApprovedDispatchExecutionStatus {
  if (!input.success) return "failed";
  return isLighterUnresolvedResult(input.data) ? "indeterminate" : "succeeded";
}

/**
 * Side effects after `approved_in_tx` snapshot — claim the continuation, take
 * the dispatch slot, dispatch the tool, commit the result, return the
 * IPC-facing outcome.
 */
export async function applyApproveSideEffects(
  approvalId: string,
  snapshot: Extract<ApproveSnapshot, { type: "approved_in_tx" }>,
): Promise<ApprovePrepareOutcome> {
  const row = snapshot.row;
  // A3 - a Vex Studio approval takes its own sibling path. The branch is here,
  // at the top of the ONLY dispatch path, because everything below is written
  // for an agent session: a session-hydrated tool context, a transcript tool
  // result, a resumed turn. None of those exists for a call an external coding
  // agent made, and reusing them would wake the backing session's agent for a
  // tool call it never made. Nothing below this line changed.
  if (row.origin === "studio_mcp") {
    return applyStudioApproveSideEffects(approvalId, snapshot);
  }
  const sessionId = row.session_id;
  const missionRunId = row.mission_run_id;
  const fallbackToolCallId =
    row.queue_tool_call_id ?? row.tool_call_id ?? approvalId;

  const toolCall = extractToolCall(row.queue_tool_call, fallbackToolCallId);

  let continuation: PreparedContinuation | null = null;
  try {
    // ── 1. Claim BEFORE dispatch ────────────────────────────────────────
    const claim = await claimResumeContinuation({
      sessionId,
      missionRunId,
      approvalId,
      ownerPrefix: "approve",
    });
    if (claim.outcome === "busy") {
      // Nothing has run. The intent stays `approved` / `not_started`, which is
      // exactly the state the reconciler knows how to finish safely.
      logger.info("engine.approval_runtime.approve_deferred_busy", {
        approvalId,
        sessionId,
        missionRunId,
      });
      scheduleDeferredResumeRetries(sessionId);
      return {
        kind: "deferred_busy",
        approvalId,
        resolvedAt: snapshot.queueResolvedAt,
        sessionId,
        missionRunId,
        resultCommitted: false,
      };
    }
    if (claim.outcome === "status_mismatch") {
      // The run is no longer resumable (terminal / cancelled). Retrying can
      // never succeed, so escalate rather than defer.
      throw new ApprovalPostDecisionError(
        approvalId,
        RESUME_CLAIM_ERROR_KIND,
        shortSha256("resume_claim_failed"),
      );
    }
    continuation = claim.continuation;

    // ── 2. Build the resumed tool context ───────────────────────────────
    // Context construction first, gate second: everything between the gate and
    // `dispatchTool` is a window in which a committed Stop would still permit a
    // call that has not started. Hydrating the session is a read — it moves no
    // funds — so building it BEFORE the gate costs nothing and leaves the gate
    // adjacent to the dispatch.
    const toolContext = await buildResumedApprovalToolContext({
      sessionId,
      missionRunId,
      permissionAtEnqueue: row.queue_permission_at_enqueue,
      // C0 provenance: the resumed dispatch names the approval that authorized it.
      approvalId,
      // ...and WHICH QUOTE it authorized. Read from the stored envelope, which
      // the request digest below covers, so the row the execute claims is the
      // row the human's card named rather than whichever quote is newest by the
      // time they clicked Approve.
      approvedQuoteAuthority: readApprovalQuoteAuthority(row.queue_tool_call),
    });

    // ── 3. Operator-Stop gate + dispatch slot, ONE transaction ──────────
    // See `dispatch-approved/dispatch-slot-gate.ts` for why these two writes
    // share a transaction and why the CAS runs even on the stopped path. The
    // transaction COMMITS here, before the dispatch below.
    const slotGate = await claimDispatchSlotUnderStopGate({
      approvalId,
      sessionId,
      missionRunId,
    });

    if (!slotGate.tookSlot) {
      // Another writer already owns this dispatch. We must NOT run the tool a
      // second time — hand the lease back and let the owner finish.
      logger.warn("engine.approval_runtime.dispatch_slot_taken", {
        approvalId,
        sessionId,
        missionRunId,
      });
      await discardContinuation(continuation);
      continuation = null;
      return {
        kind: "deferred_busy",
        approvalId,
        resolvedAt: snapshot.queueResolvedAt,
        sessionId,
        missionRunId,
        resultCommitted: false,
      };
    }

    // ── 4. Dispatch ─────────────────────────────────────────────────────
    // EVERY `stopped` verdict suppresses the dispatch, whatever its scope.
    //
    // This used to read `&& missionRunId !== null`, on the reasoning that the
    // gate could not return `stopped` without a run. Once a session-scoped
    // `stop_terminal` became a real row that reasoning inverted into a
    // money-path hole: the gate legitimately reported `stopped` for a chat
    // session, the second half of the condition was false, and control fell
    // through to `dispatchTool` — an approved swap or transfer executing after
    // the operator pressed Stop. Nothing downstream would have caught it: the
    // intent is already `dispatching`, and a session stop only rejects PENDING
    // approvals.
    //
    // The lesson generalises, so the branch is written to need no update if a
    // third scope ever appears: `stopped` means stopped.
    if (slotGate.stopGate.kind === "stopped") {
      const held = continuation;
      continuation = null;
      return abandonDispatchAfterOperatorStop({
        approvalId,
        sessionId,
        missionRunId,
        runStatus: slotGate.stopGate.runStatus,
        scope: slotGate.stopGate.scope,
        toolCallId: toolCall.toolCallId,
        continuation: held,
      });
    }

    // `data` is threaded through so the approved tool-result carries coherent
    // explorer refs (metadata-only); the committed execution status still keys
    // only off `success`/`output`.
    let dispatchResult: {
      success: boolean;
      output: string;
      data?: Record<string, unknown>;
      // POST-approval dispatch wall clock (ToolResult.durationMs) — the
      // narrow local type must not silently drop it (C1: null is never 0).
      durationMs?: number;
    };
    // MANIFEST IDENTITY, fail closed. The contract behind a canonicalized
    // direct call can change while the approval waits in the queue; executing
    // against a different contract than the human approved is exactly the
    // silent substitution the envelope's fingerprint exists to prevent. This is
    // a CONTROLLED failure, not a throw: the refusal is committed as the tool
    // result and the agent resumes knowing nothing ran (a throw would park the
    // run in `paused_error` and offer `/retry` on an action that must not be
    // retried without a fresh approval). It sits AFTER the slot claim so the
    // refused approval is terminal and cannot be re-dispatched.
    const identity = checkApprovalManifestIdentity(row.queue_tool_call);
    // THE REQUEST DIGEST, the same check and the same owner the Studio lane
    // uses. It is what a co-edit of the stored envelope cannot survive: the card
    // and the envelope can be changed together and still agree with each other,
    // but neither can be changed into agreement with the digest recorded when
    // the human approved. Fail closed, and a CONTROLLED failure exactly like the
    // identity refusal above - nothing ran, so the agent resumes knowing that.
    // A `null` digest is a row written before the column existed; see
    // `approvalRequestDigestMatches`.
    if (!identity.ok) {
      logger.warn("engine.approval_runtime.manifest_identity_refused", {
        approvalId,
        sessionId,
        missionRunId,
        reason: identity.reason,
      });
      dispatchResult = { success: false, output: identity.refusal };
    } else if (!approvalRequestDigestMatches(row.queue_tool_call, row.request_digest)) {
      logger.warn("engine.approval_runtime.request_digest_mismatch", {
        approvalId,
        sessionId,
        missionRunId,
      });
      dispatchResult = {
        success: false,
        output:
          "Approved action refused: the stored request no longer matches the one this approval was "
          + "granted for. Nothing was executed and no funds moved. Call the tool again with the "
          + "parameters you want and request a fresh approval.",
      };
    } else {
      try {
        dispatchResult = await dispatchTool(
          {
            name: toolCall.toolName,
            args: toolCall.toolArgs,
            toolCallId: toolCall.toolCallId,
          },
          toolContext,
        );
      } catch (cause) {
        // The continuation is deliberately left owned by this scope: the outer
        // catch releases it in its `finally`, AFTER the terminal status write,
        // so the release does not publish a stale `running` to the renderer.
        await onDispatchThrow(
          approvalId,
          sessionId,
          missionRunId,
          toolCall.toolCallId,
          cause,
        );
        // unreachable — onDispatchThrow always throws ApprovalDispatchError
        throw new Error("unreachable");
      }
    }

    // ── 5. Commit result + result_message_id in ONE transaction ─────────
    // FIRST, before the stop below. The dispatch ran unlocked and may already
    // have moved funds; that outcome is durable history and a Stop that
    // arrived afterwards must not cost us the record of it.
    const executionStatus = deriveApprovedDispatchExecutionStatus(dispatchResult);
    await commitApprovedToolResult({
      approvalId,
      sessionId,
      toolCallId: toolCall.toolCallId,
      dispatchResult,
      executionStatus,
      explorerRefs: deriveExplorerRefs(dispatchResult.data),
      // DISPLAY-only: an approved swap whose receipt never came back is the
      // exact case that rendered a red FAILED above its own "pending" prose.
      ...displayStatusPayload(dispatchResult.data),
      durationMs: dispatchResult.durationMs,
    });

    // ── 6. A Stop that landed during the dispatch now takes effect ──────
    // The executed call is NOT undone (the in-flight rule) and nothing is
    // re-dispatched — but the operator's Stop is applied durably here rather
    // than left queued for a resumed turn that this very stop means we must
    // not start. Suppressing the continuation is the point: handing it back
    // would resume the agent on a run the user just stopped.
    const stopAfterDispatch = await applyQueuedOperatorStop({
      approvalId,
      sessionId,
      missionRunId,
    });
    if (stopAfterDispatch.kind === "stopped") {
      const held = continuation;
      continuation = null;
      if (held !== null) await discardContinuation(held);
    } else if (stopAfterDispatch.kind === "apply_failed") {
      // We could not find out whether a Stop is queued, and nothing else will
      // land it for a run nobody is iterating (see the helper's docblock). The
      // tool result is already committed, so the durable history is safe;
      // resuming the agent is the one thing we must not do on a guess. Escalate
      // as a post-decision failure: the catch funnel below retries the stop and
      // then parks the run, which is exactly the treatment every other
      // post-dispatch persistence failure gets.
      throw new ApprovalPostDecisionError(
        approvalId,
        STOP_APPLY_FAILED_ERROR_KIND,
        shortSha256(STOP_APPLY_FAILED_ERROR_KIND),
      );
    }

    return {
      kind: "dispatched",
      approvalId,
      resolvedAt: snapshot.queueResolvedAt,
      executionStatus,
      sessionId,
      missionRunId,
      // `null` here is the honest "the tool ran, the agent was NOT resumed"
      // shape the outcome already models (IPC maps it to `runtimeOutcome:
      // "stopped"`), which is exactly what an operator Stop produces.
      continuation,
      toolResult: {
        success: dispatchResult.success,
        output: dispatchResult.output,
      },
    };
  } catch (cause) {
    // Any escape from the block above means no caller will consume the
    // continuation. Release it rather than leak the lease until TTL — but only
    // AFTER the terminal status is written, because the release emits the run's
    // current status to the renderer and would otherwise publish a stale
    // `running` right before we flip it to `paused_error`.
    const held = continuation;
    continuation = null;
    try {
      // TERMINAL-STOP PRECEDENCE — one funnel, every failure exit.
      // Whatever went wrong above, the dispatch's own outcome (a committed
      // result, or the structural failure row `onDispatchThrow` wrote) is
      // already durable, so it is now safe to land the operator's queued Stop.
      // It runs BEFORE any parking decision below: those all go through
      // `flipRunToPausedError`, whose CAS then refuses to reopen the terminal
      // row this call just produced. Never throws — see the helper.
      const stopOnFailure = await applyQueuedOperatorStop({
        approvalId,
        sessionId,
        missionRunId,
      });
      if (stopOnFailure.kind === "apply_failed") {
        // Named, not swallowed: the run parks below (so nothing further runs),
        // but a queued Stop may still be sitting `pending` with no independent
        // consumer. It lands only if this same run is resumed later.
        logger.error("engine.approval_runtime.stop_apply_unresolved", {
          approvalId,
          sessionId,
          missionRunId,
          errorKind: stopOnFailure.errorKind,
        });
      }

      if (cause instanceof ApprovalDispatchError) {
        // The flip lives here rather than in `onDispatchThrow` so there is
        // exactly one ordering to reason about: result → stop → paused_error.
        if (missionRunId !== null) {
          await flipRunToPausedError({
            approvalId,
            sessionId,
            missionRunId,
            errorKind: cause.errorKind,
            evidence: {
              errorHash: cause.errorHash,
              cause: "dispatch_threw",
            },
          });
        }
        throw cause;
      }
      if (cause instanceof ApprovalResultSupersededError) {
        // We woke up after losing ownership: the reconciler already declared
        // this dispatch `indeterminate`, wrote the honest tool result, and
        // resumed the agent. The result transaction rolled back, so nothing was
        // overwritten and no second tool result exists. Deliberately NOT a
        // `paused_error` flip — the run has already been recovered, and
        // knocking it back down would undo that recovery.
        logger.warn("engine.approval_runtime.result_superseded", {
          approvalId,
          sessionId,
          missionRunId,
        });
        throw new ApprovalPostDecisionError(
          approvalId,
          RESULT_SUPERSEDED_ERROR_KIND,
          shortSha256(RESULT_SUPERSEDED_ERROR_KIND),
        );
      }
      if (cause instanceof ApprovalPostDecisionError) {
        if (missionRunId !== null) {
          await flipRunToPausedError({
            approvalId,
            sessionId,
            missionRunId,
            errorKind: cause.errorKind,
            evidence: { errorHash: cause.errorHash },
          });
        }
        throw cause;
      }
      // Unhandled post-tx persistence failure (CAS / result commit threw). Flip
      // the run to `paused_error` and surface as ApprovalPostDecisionError so
      // IPC can return a safe `approvals.dispatch_failed` error.
      const errSummary = summarizeErrorForLog(cause);
      logger.warn("engine.approval_runtime.post_decision_failed", {
        approvalId,
        sessionId,
        missionRunId,
        errorKind: errSummary.errorKind,
        errorHash: errSummary.errorHash,
      });
      if (missionRunId !== null) {
        await flipRunToPausedError({
          approvalId,
          sessionId,
          missionRunId,
          errorKind: errSummary.errorKind,
          evidence: { errorHash: errSummary.errorHash },
        });
      }
      throw new ApprovalPostDecisionError(
        approvalId,
        errSummary.errorKind,
        errSummary.errorHash,
      );
    } finally {
      if (held !== null) await discardContinuation(held);
    }
  }
}
