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
 *   - `engine_stop` (stop_mission, complete_subagent, waiting_for_parent)
 *     → caller returns.
 *   - `compact_committed` → caller runs `handlePostCompactBookkeeping`
 *     then continues to the next iteration.
 *   - `normal_complete` → caller runs `mergeOperatorInstructions` then
 *     continues to the next iteration.
 *
 * Helper mutates `args.liveMessages` directly (push of assistant
 * message + tool results) — matches the pre-extraction site where the
 * mutation lived inline. This is the only side-effect on caller state
 * besides DB writes via `dispatchTool` / `saveAssistantMessage` /
 * `persistToolResultWithOverflow` / `approvalsRepo.enqueue` /
 * `missionRunsRepo.updateStatus("paused_approval")`.
 *
 * Structural split: the outcome contract lives in
 * `./turn-loop-tool-batch/outcome.ts`, the per-call tool-context builder in
 * `./turn-loop-tool-batch/execute.ts`, the approval-enqueue helpers in
 * `./turn-loop-tool-batch/approval-stop.ts`, and the deferred-save +
 * outcome-mapping helpers in `./turn-loop-tool-batch/results.ts`.
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
import type { BatchTurnResult, StopPayload, ToolBatchOutcome } from "./turn-loop-tool-batch/outcome.js";
import { buildToolContext } from "./turn-loop-tool-batch/execute.js";
import {
  assertApprovalActionKind,
  enqueueApprovalIntent,
} from "./turn-loop-tool-batch/approval-stop.js";
import {
  BATCH_ABORTED_BY_COMPACT_OUTPUT,
  mapBatchOutcome,
  persistBatchTranscript,
} from "./turn-loop-tool-batch/results.js";

export type { StopPayload, ToolBatchOutcome } from "./turn-loop-tool-batch/outcome.js";

export async function processTurnToolBatch(args: {
  readonly context: EngineContext;
  readonly turnResult: BatchTurnResult;
  /** MUTATED: pushed with assistant message + tool result messages. */
  readonly liveMessages: Message[];
  readonly currentTokenCount: number;
  readonly contextLimit: number;
  readonly lastTextSoFar: string | null;
}): Promise<ToolBatchOutcome> {
  const { context, turnResult, liveMessages } = args;
  const executedCalls: ParsedToolCall[] = [];
  const executedResults: Array<{
    toolCallId: string;
    toolName: string;
    output: string;
    success: boolean;
    explorerRefs: readonly ExplorerRef[];
  }> = [];

  let toolCallsExecuted = 0;
  let batchStopReason: StopReason | null = null;
  let batchStopOutput: string | null = null;
  let batchStopPayload: StopPayload | undefined;
  let compactCommittedThisBatch = false;
  let approvalId: string | null = null;

  const dispatchBand = computeBand(args.currentTokenCount, args.contextLimit);

  for (let i = 0; i < turnResult.toolCalls.length; i++) {
    const toolCall = turnResult.toolCalls[i];
    toolCallsExecuted++;

    const toolContext = buildToolContext(context, dispatchBand);

    const result = await dispatchTool(
      { name: toolCall.name, args: toolCall.arguments, toolCallId: toolCall.id },
      toolContext,
    );

    // ── Approval break: call was dispatched but has no result in messages ──
    // "awaiting approval" state lives in approval_queue, not in transcript.
    if (result.pendingApproval) {
      // Puzzle 5 phase 2: approval_intents.action_kind is NOT NULL with a
      // CHECK constraint over the 8 canonical ActionKind variants. The
      // dispatcher's `withActionKindFallback` MUST have stamped a kind
      // before this branch — a missing stamp here is a bug in tool
      // registration or in the dispatcher fallback. Fail fast (Codex
      // 2/1B ruling) instead of silently inserting a pseudo-kind or
      // downgrading to a default — neither preserves the policy invariant.
      const intentActionKind = assertApprovalActionKind(result, toolCall);

      executedCalls.push(toolCall);

      approvalId = await enqueueApprovalIntent({
        context,
        toolCall,
        result,
        toolContext,
        intentActionKind,
      });
      batchStopReason = "approval_required";
      break; // remaining calls are NOT dispatched
    }

    // Track executed call + result
    executedCalls.push(toolCall);
    executedResults.push({
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      output: result.output,
      success: result.success,
      // Derive explorer refs from `result.data` HERE — the transcript drops
      // `data`, so this is the last place the structured capture is available.
      explorerRefs: deriveExplorerRefs(result.data),
    });

    // ── Engine signals: result tracked, then stop ──
    if (result.engineSignal) {
      const sig = result.engineSignal;
      if (sig.type === "stop_mission" || sig.type === "complete_subagent") {
        batchStopReason = sig.reason as StopReason;
        batchStopOutput = result.output;
        batchStopPayload = { summary: sig.summary, evidence: sig.evidence };
        break;
      }
      if (sig.type === "wait_for_parent") {
        batchStopReason = "waiting_for_parent";
        batchStopOutput = result.output;
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
        batchStopOutput = result.output;
        batchStopPayload = { summary: sig.summary, evidence: { reason: sig.reason } };
        break;
      }
      if (sig.type === "defer_until") {
        // `loop_defer` handler already persisted the pending wake row.
        // Turn-loop parks the mission run in `paused_wake` and exits.
        // Evidence carries dueAt + reason so PR-7 executor / PR-10 ingress
        // have the hints they need without re-reading the wake row.
        batchStopReason = "waiting_for_wake";
        batchStopOutput = result.output;
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
        for (let j = i + 1; j < turnResult.toolCalls.length; j++) {
          const skipped = turnResult.toolCalls[j];
          executedCalls.push(skipped);
          executedResults.push({
            toolCallId: skipped.id,
            toolName: skipped.name,
            output: BATCH_ABORTED_BY_COMPACT_OUTPUT,
            success: false,
            explorerRefs: [],
          });
        }
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
  });

  // Update lastText from current turn (assistant may have content alongside toolCalls)
  const lastText = turnResult.content ?? args.lastTextSoFar;

  return mapBatchOutcome({
    batchStopReason,
    batchStopOutput,
    batchStopPayload,
    compactCommittedThisBatch,
    approvalId,
    toolCallsExecuted,
    lastText,
  });
}
