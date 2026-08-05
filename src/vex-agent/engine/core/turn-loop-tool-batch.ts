/**
 * Per-turn tool-batch processor — owns the dispatch loop, deferred
 * save, and all engine-signal handling for a single turn that
 * returned tool calls. Extracted from `turn-loop.ts` for scaling.
 *
 * Deferred-save invariant preserved bit-for-bit:
 *   - `saveAssistantMessage` is called with the canonical batch
 *     prefix (only calls that entered dispatch).
 *   - Each `executedCalls[i]` has 0 or 1 matching `executedResults`
 *     entry (0 only when pendingApproval was returned).
 *   - On `compact_committed` engine signal: remaining calls in the
 *     batch are drained with synthetic `batch_aborted_by_compact`
 *     tool results so the persisted assistant message's `tool_calls`
 *     JSONB still reflects the full emitted batch and the provider's
 *     tool_call/tool_result pairing stays balanced on reload.
 *
 * Caller-orchestrated post-batch state:
 *   - `approval_break` → caller returns immediately.
 *   - `waiting_for_wake` → caller runs forced-compact-before-wait +
 *     `missionRunsRepo.updateStatus("paused_wake")` + returns.
 *   - `engine_stop` (stop_mission) → caller returns.
 *   - `compact_committed` → caller runs `handlePostCompactBookkeeping`
 *     then continues to the next iteration.
 *   - `normal_complete` → caller runs `mergeOperatorInstructions` then
 *     continues to the next iteration.
 *
 * Helper mutates `args.liveMessages` directly (push of assistant
 * message + tool results) — matches the pre-extraction site where the
 * mutation lived inline. This is the only side-effect on caller state
 * besides DB writes via `dispatchTool` / `saveAssistantMessage` /
 * `persistBatchTranscript` / `approvalsRepo.enqueue` /
 * `missionRunsRepo.updateStatus("paused_approval")`.
 *
 * Structural split: the outcome contract lives in
 * `./turn-loop-tool-batch/outcome.ts`, the per-call tool-context builder in
 * `./turn-loop-tool-batch/execute.ts`, the approval-enqueue helpers in
 * `./turn-loop-tool-batch/approval-stop.ts`, the §C3b user-form park in
 * `./turn-loop-tool-batch/user-form-stop.ts`, the deferred-save +
 * outcome-mapping helpers in `./turn-loop-tool-batch/results.ts`, and the
 * trusted prepare→execute handoff in
 * `./turn-loop-tool-batch/prepared-follow-up.ts`.
 * `processTurnToolBatch` stays here as the orchestrator: it keeps the
 * per-batch mutable state and the dispatch/approval/persistence ordering
 * bit-for-bit.
 */

import type { EngineContext, StopReason } from "../types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import { computeBand } from "./context-band.js";
import { deriveExplorerRefs, type ExplorerRef } from "./explorer-refs.js";
import { displayStatusPayload } from "./tool-display-status.js";
import type { BatchTurnResult, StopPayload, ToolBatchOutcome } from "./turn-loop-tool-batch/outcome.js";
import { buildToolContext } from "./turn-loop-tool-batch/execute.js";
import {
  assertApprovalActionKind,
  enqueueApprovalIntent,
} from "./turn-loop-tool-batch/approval-stop.js";
import {
  APPROVAL_AUTO_REJECTED_RUN_TERMINAL_OUTPUT,
  USER_FORM_ABANDONED_RUN_TERMINAL_OUTPUT,
  APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT,
  BATCH_ABORTED_BY_COMPACT_OUTPUT,
  BATCH_ABORTED_BY_DEADLINE_OUTPUT,
  BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
  BATCH_ABORTED_BY_USER_STOP_OUTPUT,
  mapBatchOutcome,
  persistBatchTranscript,
} from "./turn-loop-tool-batch/results.js";
import { parkTurnOnUserForm } from "./turn-loop-tool-batch/user-form-stop.js";
import {
  evaluateBatchDeadlines,
  type BatchDeadlines,
} from "./turn-loop-tool-batch/deadline.js";
import {
  dispatchPreparedActionFollowUp,
  resolvePreparedActionFollowUp,
} from "./turn-loop-tool-batch/prepared-follow-up.js";

export type { StopPayload, ToolBatchOutcome } from "./turn-loop-tool-batch/outcome.js";

export async function processTurnToolBatch(args: {
  readonly context: EngineContext;
  readonly turnResult: BatchTurnResult;
  /** MUTATED: pushed with assistant message + tool result messages. */
  readonly liveMessages: Message[];
  readonly currentTokenCount: number;
  readonly contextLimit: number;
  /**
   * C8 barrier bypass for this turn, derived from the loop's single per-turn
   * preparation read. Defaults to `false` for callers that do not compute it,
   * which is the fail-closed answer.
   */
  readonly preparationBypassesBarrier?: boolean;
  readonly lastTextSoFar: string | null;
  /**
   * Operator Stop. Checked at the top of each per-call iteration AND again
   * once a dispatch returns — never mid-dispatch: a signing / broadcast call
   * already in flight must always be allowed to finish, because we cannot know
   * whether it already moved funds. Mission runs pass the run's abort signal;
   * chat turns pass the "stop generating" inference signal.
   */
  readonly abortSignal?: AbortSignal;
  /**
   * Wall-clock bounds, checked at the top of each per-call iteration — never
   * mid-dispatch, for the same reason as the Stop above. Without this both
   * bounds are only sampled between iterations, so a slow batch overshoots them
   * by an unbounded margin. See `./turn-loop-tool-batch/deadline.ts`.
   */
  readonly deadlines?: BatchDeadlines;
}): Promise<ToolBatchOutcome> {
  const { context, turnResult, liveMessages } = args;
  const executedCalls: ParsedToolCall[] = [];
  const executedResults: Array<{
    toolCallId: string;
    toolName: string;
    output: string;
    success: boolean;
    explorerRefs: readonly ExplorerRef[];
    /** Present only for entries that actually ran — never 0 for synthetic ones. */
    durationMs?: number;
  }> = [];

  let toolCallsExecuted = 0;
  let batchStopReason: StopReason | null = null;
  let batchStopOutput: string | null = null;
  let batchStopPayload: StopPayload | undefined;
  let compactCommittedThisBatch = false;
  let approvalId: string | null = null;
  let userFormIntentId: string | null = null;

  const dispatchBand = computeBand(args.currentTokenCount, args.contextLimit);

  /**
   * Pair every call from `fromIndex` onward with a synthetic result so the
   * persisted assistant message's `tool_calls` JSONB still reflects the FULL
   * emitted batch and the provider's tool_call/tool_result pairing stays
   * balanced after a reload. Used by both batch-abort paths (compact commit
   * and operator stop).
   */
  function drainUndispatchedCalls(fromIndex: number, output: string): void {
    for (let j = fromIndex; j < turnResult.toolCalls.length; j++) {
      const skipped = turnResult.toolCalls[j];
      if (skipped === undefined) continue;
      executedCalls.push(skipped);
      executedResults.push({
        toolCallId: skipped.id,
        toolName: skipped.name,
        output,
        success: false,
        explorerRefs: [],
      });
    }
  }

  for (let i = 0; i < turnResult.toolCalls.length; i++) {
    const toolCall = turnResult.toolCalls[i];
    // `i < turnResult.toolCalls.length` guarantees this index is populated;
    // the guard exists only to satisfy `noUncheckedIndexedAccess` (vex-app's
    // stricter tsconfig type-checks this file too) and narrows `toolCall` for
    // every use below.
    if (toolCall === undefined) continue;

    // ── Operator Stop, checked at the TOP of the iteration ──
    // Deliberately BEFORE `dispatchTool` and never inside it: a call already
    // in flight (a signature, a broadcast) must run to completion so we never
    // lose the outcome of something that may already have moved funds.
    // Everything from here on was NOT dispatched, so drain it with synthetic
    // results and reuse the existing `user_stopped` stop reason.
    if (args.abortSignal?.aborted) {
      drainUndispatchedCalls(i, BATCH_ABORTED_BY_USER_STOP_OUTPUT);
      batchStopReason = "user_stopped";
      break;
    }

    // ── Wall-clock bounds, also at the TOP of the iteration ──
    // Ordered AFTER the Stop (an operator's explicit request outranks a bound
    // that merely expired) and, like it, never mid-dispatch. This is the only
    // place either bound can be observed inside a batch, so it is what keeps
    // the overshoot to a single tool call instead of a whole batch.
    const breach = evaluateBatchDeadlines(args.deadlines, Date.now());
    if (breach !== null) {
      const isMissionDeadline = breach.kind === "mission_deadline";
      drainUndispatchedCalls(
        i,
        isMissionDeadline
          ? BATCH_ABORTED_BY_DEADLINE_OUTPUT
          : BATCH_ABORTED_BY_TIMEOUT_OUTPUT,
      );
      batchStopReason = isMissionDeadline ? "deadline_reached" : "timeout";
      break;
    }

    toolCallsExecuted++;

    const toolContext = buildToolContext(
      context,
      dispatchBand,
      args.preparationBypassesBarrier === true,
      args.abortSignal,
    );

    const result = await dispatchTool(
      { name: toolCall.name, args: toolCall.arguments, toolCallId: toolCall.id },
      toolContext,
    );

    // Trusted prepare→execute handoff (wallet_send_prepare → confirm ONLY,
    // see the registry allow-list): validates the handler-authored contract
    // and fails closed (never dispatches) on any unknown mapping or
    // malformed shape. `resultForTranscript` is what actually gets
    // persisted/returned below — identical to `result` unless the follow-up
    // was rejected, in which case it carries the rejection message instead.
    const { resultForTranscript, followUp } = resolvePreparedActionFollowUp(
      toolCall.name,
      result,
    );

    // ── Operator Stop, re-checked AFTER the dispatch returned ──
    // The pre-dispatch check above only proves the operator had not stopped
    // when this call STARTED. A Stop that arrives while the call is in flight
    // must still be honoured before the runtime takes its next irreversible
    // step, and there are two of those right below: enqueueing an approval
    // (a durable, approvable action parked on a run that is about to die) and
    // dispatching the prepared-action follow-up — the leg that actually signs.
    // The call we just ran is persisted truthfully; everything after it is
    // drained unexecuted, so the tool_call/tool_result pairing survives.
    if (args.abortSignal?.aborted) {
      executedCalls.push(toolCall);
      executedResults.push({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        // A `pendingApproval` result means nothing executed and no approval
        // will now be created — say that, rather than echoing an
        // "approval required" line no approval backs.
        output: resultForTranscript.pendingApproval
          ? APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT
          : resultForTranscript.output,
        success: resultForTranscript.pendingApproval
          ? false
          : resultForTranscript.success,
        explorerRefs: resultForTranscript.pendingApproval
          ? []
          : deriveExplorerRefs(resultForTranscript.data),
        // Suppressed on the pendingApproval branch for the same reason the
        // refs are: nothing executed, so the result's `data` describes an act
        // that never happened.
        ...(resultForTranscript.pendingApproval
          ? {}
          : displayStatusPayload(resultForTranscript.data)),
      });
      drainUndispatchedCalls(i + 1, BATCH_ABORTED_BY_USER_STOP_OUTPUT);
      batchStopReason = "user_stopped";
      break;
    }

    // ── Approval break: call was dispatched but has no result in messages ──
    // "awaiting approval" state lives in approval_queue, not in transcript.
    if (resultForTranscript.pendingApproval) {
      // Puzzle 5 phase 2: approval_intents.action_kind is NOT NULL with a
      // CHECK constraint over the 8 canonical ActionKind variants. The
      // dispatcher's `withActionKindFallback` MUST have stamped a kind
      // before this branch — a missing stamp here is a bug in tool
      // registration or in the dispatcher fallback. Fail fast (Codex
      // 2/1B ruling) instead of silently inserting a pseudo-kind or
      // downgrading to a default — neither preserves the policy invariant.
      const intentActionKind = assertApprovalActionKind(resultForTranscript, toolCall);

      executedCalls.push(toolCall);

      const enqueueOutcome = await enqueueApprovalIntent({
        context,
        toolCall,
        result: resultForTranscript,
        toolContext,
        intentActionKind,
      });
      if (enqueueOutcome.kind === "auto_rejected") {
        // The run went terminal while this tool was in flight, so the
        // approval was rejected inside the enqueue transaction instead of
        // parking on a dead run. Give this call a result (pairing) and drain
        // the rest — none of them were dispatched.
        executedResults.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          output: APPROVAL_AUTO_REJECTED_RUN_TERMINAL_OUTPUT,
          success: false,
          explorerRefs: [],
        });
        drainUndispatchedCalls(i + 1, BATCH_ABORTED_BY_USER_STOP_OUTPUT);
        batchStopReason = "user_stopped";
        break;
      }
      approvalId = enqueueOutcome.approvalId;
      batchStopReason = "approval_required";
      break; // remaining calls are NOT dispatched
    }

    // ── User-form break: same shape as the approval break above ──
    // The call was dispatched and DRAFTED a durable form, but its answer comes
    // from a human later. "Awaiting the human" lives in `token_launch_intents`,
    // not in the transcript, so this call gets NO result here — appending one
    // would leave the resume unable to answer without writing a SECOND result
    // for the same tool_call_id.
    if (resultForTranscript.pendingUserForm) {
      const { intentId } = resultForTranscript.pendingUserForm;
      executedCalls.push(toolCall);

      const parkOutcome = await parkTurnOnUserForm({ context, intentId });
      if (parkOutcome.kind === "abandoned") {
        // The run went terminal while the handler was drafting. Nothing is
        // parked and no dialog was pushed, so this call must carry a truthful
        // result — an unanswered call would break the provider's pairing.
        executedResults.push({
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          output: USER_FORM_ABANDONED_RUN_TERMINAL_OUTPUT,
          success: false,
          explorerRefs: [],
        });
        drainUndispatchedCalls(i + 1, BATCH_ABORTED_BY_USER_STOP_OUTPUT);
        batchStopReason = "user_stopped";
        break;
      }
      userFormIntentId = intentId;
      batchStopReason = "user_form_required";
      break; // remaining calls are NOT dispatched
    }

    // Track executed call + result
    executedCalls.push(toolCall);
    executedResults.push({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: resultForTranscript.output,
      success: resultForTranscript.success,
      // Derive explorer refs from `result.data` HERE — the transcript drops
      // `data`, so this is the last place the structured capture is available.
      explorerRefs: deriveExplorerRefs(resultForTranscript.data),
      ...(resultForTranscript.durationMs !== undefined
        ? { durationMs: resultForTranscript.durationMs }
        : {}),
      // DISPLAY-only axis (never the model's truth): marks an ambiguous
      // broadcast so the UI can say "Pending" instead of "Failed".
      ...displayStatusPayload(resultForTranscript.data),
    });

    // A validated prepared-action follow-up short-circuits the rest of this
    // batch: persist the prepare call above, then synthesize + dispatch the
    // trusted confirm call and return its own outcome directly (restricted
    // sessions enqueue the normal approval flow; full-permission sessions
    // execute confirm immediately). Remaining calls in THIS batch are never
    // reached — the model only ever emitted one call when it called prepare.
    if (followUp !== null) {
      return dispatchPreparedActionFollowUp({
        context,
        toolContext,
        content: turnResult.content,
        reasoning: turnResult.reasoning,
        executedCalls,
        executedResults,
        liveMessages,
        followUp,
        toolCallsExecuted,
        lastText: turnResult.content ?? args.lastTextSoFar,
        // The follow-up is the signing leg: it re-checks the Stop immediately
        // before dispatching the confirm and again before enqueueing its
        // approval, because the transcript write between here and there is a
        // real window.
        abortSignal: args.abortSignal,
      });
    }

    // ── Engine signals: result tracked, then stop ──
    if (resultForTranscript.engineSignal) {
      const sig = resultForTranscript.engineSignal;
      if (sig.type === "stop_mission") {
        batchStopReason = sig.reason as StopReason;
        batchStopOutput = resultForTranscript.output;
        batchStopPayload = { summary: sig.summary, evidence: sig.evidence };
        break;
      }
      if (sig.type === "plan_pause") {
        // `plan_write` in an active mission run created/changed an unaccepted
        // plan. Park the run in `paused_plan_acceptance`; once accepted it
        // resumes via `plan.accept` or any control resume path (not a user chat
        // message — see RUNTIME_PAUSES vs RESUMABLE_STOPS). Pause IMMEDIATELY
        // (don't wait for an execution attempt — mission text does not break the
        // loop).
        batchStopReason = "plan_acceptance_required";
        batchStopOutput = resultForTranscript.output;
        batchStopPayload = { summary: sig.summary, evidence: { reason: sig.reason } };
        break;
      }
      if (sig.type === "defer_until") {
        // `loop_defer` handler already persisted the pending wake row.
        // Turn-loop parks the mission run in `paused_wake` and exits.
        // Evidence carries dueAt + reason so PR-7 executor / PR-10 ingress
        // have the hints they need without re-reading the wake row.
        batchStopReason = "waiting_for_wake";
        batchStopOutput = resultForTranscript.output;
        batchStopPayload = {
          summary: sig.summary,
          evidence: {
            dueAt: sig.dueAt ?? null,
            reason: sig.reason,
          },
        };
        break;
      }
      if (sig.type === "compact_committed") {
        // Drain remaining tool calls in this batch with synthetic
        // batch_aborted_by_compact results. The assistant message that
        // gets persisted still carries the FULL emitted batch in its
        // tool_calls JSONB so the provider's tool_call/tool_result
        // pairing stays balanced after reload.
        compactCommittedThisBatch = true;
        drainUndispatchedCalls(i + 1, BATCH_ABORTED_BY_COMPACT_OUTPUT);
        break;
      }
    }
  }

  await persistBatchTranscript({
    sessionId: context.sessionId,
    content: turnResult.content,
    executedCalls,
    executedResults,
    liveMessages,
    reasoning: turnResult.reasoning,
  });

  // Update lastText from current turn (assistant may have content alongside toolCalls)
  const lastText = turnResult.content ?? args.lastTextSoFar;

  return mapBatchOutcome({
    batchStopReason,
    batchStopOutput,
    batchStopPayload,
    compactCommittedThisBatch,
    approvalId,
    userFormIntentId,
    toolCallsExecuted,
    lastText,
  });
}
