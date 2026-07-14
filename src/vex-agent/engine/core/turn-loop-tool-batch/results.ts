/**
 * Result aggregation helpers — deferred-save transcript persistence and the
 * final outcome mapping for a processed tool batch.
 *
 * Extracted verbatim from `turn-loop-tool-batch.ts`. The orchestrator owns
 * the per-batch mutable state and the loop; this module owns the
 * post-loop persistence block (assistant save precedes tool-result saves)
 * and the discriminated-outcome mapping. Ordering is preserved bit-for-bit.
 */

import type { StopReason } from "../../types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import type { ExplorerRef } from "../explorer-refs.js";
import { saveAssistantMessage } from "../turn.js";
import { persistToolResultWithOverflow } from "../tool-output-overflow.js";
import type { StopPayload, ToolBatchOutcome } from "./outcome.js";

/** Synthetic tool-result emitted for batch tool calls skipped after a `compact_committed` signal. */
export const BATCH_ABORTED_BY_COMPACT_OUTPUT =
  "batch_aborted_by_compact: this tool call was emitted in the same batch as compact_now and was not dispatched. "
  + "The conversation has been compacted; re-emit this call on the next turn if it is still relevant.";

interface ExecutedResult {
  toolCallId: string;
  toolName: string;
  output: string;
  success: boolean;
  /** Coherent explorer refs derived from the tool's `result.data` at dispatch. */
  explorerRefs: readonly ExplorerRef[];
}

/**
 * DEFERRED SAVE: assistant message (canonical calls only) precedes the
 * tool-result saves. Mutates `liveMessages` directly — matches the
 * pre-extraction site where the mutation lived inline.
 */
export async function persistBatchTranscript(args: {
  readonly sessionId: string;
  readonly content: string | null;
  readonly executedCalls: ParsedToolCall[];
  readonly executedResults: ExecutedResult[];
  /** MUTATED: pushed with assistant message + tool result messages. */
  readonly liveMessages: Message[];
}): Promise<void> {
  const { sessionId, content, executedCalls, executedResults, liveMessages } = args;

  // ── DEFERRED SAVE: assistant message with canonical calls only ──
  await saveAssistantMessage(sessionId, content, executedCalls);

  liveMessages.push({
    role: "assistant",
    content: content ?? "",
    toolCalls: executedCalls.map((tc) => ({
      id: tc.id,
      command: tc.name,
      args: tc.arguments,
    })),
    timestamp: new Date().toISOString(),
  });

  // Save tool results (only for fully-executed, non-approval calls).
  // Oversized outputs are externalised into tool_output_blobs (PR-11) —
  // transcript gets a short stub with `metadata.payload.blob_key` so
  // archive-aware checkpoint and resume paths can keep the pointer alive.
  for (const { toolCallId, toolName, output, success, explorerRefs } of executedResults) {
    const persisted = await persistToolResultWithOverflow(
      sessionId,
      toolCallId,
      toolName,
      output,
      success,
      explorerRefs,
    );

    liveMessages.push({
      role: "tool",
      content: persisted.content,
      toolCallId,
      timestamp: new Date().toISOString(),
      metadata: persisted.metadata,
    });
  }
}

/** Map the resolved per-batch state onto the discriminated `ToolBatchOutcome`. */
export function mapBatchOutcome(args: {
  readonly batchStopReason: StopReason | null;
  readonly batchStopOutput: string | null;
  readonly batchStopPayload: StopPayload | undefined;
  readonly compactCommittedThisBatch: boolean;
  readonly approvalId: string | null;
  readonly toolCallsExecuted: number;
  readonly lastText: string | null;
}): ToolBatchOutcome {
  const {
    batchStopReason,
    batchStopOutput,
    batchStopPayload,
    compactCommittedThisBatch,
    approvalId,
    toolCallsExecuted,
    lastText,
  } = args;

  if (batchStopReason === "approval_required") {
    // Helper invariant: approval_required path always set approvalId before break.
    if (approvalId === null) {
      throw new Error("turn-loop-tool-batch: approval_required without approvalId");
    }
    return {
      kind: "approval_break",
      pendingApprovalId: approvalId,
      toolCallsExecuted,
      lastText,
    };
  }
  if (batchStopReason === "waiting_for_wake") {
    return {
      kind: "waiting_for_wake",
      text: batchStopOutput ?? lastText,
      stopPayload: batchStopPayload ?? {},
      toolCallsExecuted,
      lastText,
    };
  }
  if (batchStopReason === "plan_acceptance_required") {
    return {
      kind: "plan_acceptance_pause",
      text: batchStopOutput ?? lastText,
      stopPayload: batchStopPayload ?? {},
      toolCallsExecuted,
      lastText,
    };
  }
  if (batchStopReason) {
    return {
      kind: "engine_stop",
      stopReason: batchStopReason,
      text: batchStopOutput ?? lastText,
      stopPayload: batchStopPayload,
      toolCallsExecuted,
      lastText,
    };
  }

  if (compactCommittedThisBatch) {
    return { kind: "compact_committed", toolCallsExecuted, lastText };
  }

  return { kind: "normal_complete", toolCallsExecuted, lastText };
}
