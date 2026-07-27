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
import type { Message, MessageMetadata } from "@vex-agent/db/repos/messages.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import { appendMessage } from "@vex-agent/engine/events/index.js";
import type { ExplorerRef } from "../explorer-refs.js";
import { saveAssistantMessage } from "../turn.js";
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
  /**
   * True ONLY for the synthetic prepared-action follow-up call the engine
   * dispatches itself (never model output — see
   * `dispatchPreparedActionFollowUp`). Stamps transcript provenance so the
   * assistant-role row is never mistaken for real model output.
   */
  readonly systemOriginated?: boolean;
}): Promise<void> {
  const { sessionId, content, executedCalls, executedResults, liveMessages } = args;

  // ── DEFERRED SAVE: assistant message with canonical calls only ──
  await saveAssistantMessage(sessionId, content, executedCalls, {
    systemOriginated: args.systemOriginated,
  });

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

  // Save tool results (only for fully-executed, non-approval calls). Every
  // tool output is persisted VERBATIM and inline: the externalisation
  // mechanism (tool output blobs + a stub in the transcript) was removed —
  // the model could not tell what to look for inside a blob, so full output
  // in context beats blobbing.
  //
  // `metadata.payload` is the ONLY part of MessageMetadata that reaches the
  // `messages.metadata` JSONB column (see db/repos/messages/write.ts), so
  // `explorerRefs` lives under payload — the desktop app reads it as the
  // column's top-level `metadata -> 'explorerRefs'`. Omitted entirely when
  // empty so ref-less rows carry no extra JSONB.
  for (const { toolCallId, output, success, explorerRefs } of executedResults) {
    const metadata: MessageMetadata = {
      source: "tool",
      messageType: "tool_result",
      visibility: "internal",
      payload: {
        success,
        ...(explorerRefs.length > 0 ? { explorerRefs } : {}),
      },
    };

    await appendMessage(
      sessionId,
      { role: "tool", content: output, toolCallId, timestamp: new Date().toISOString() },
      metadata,
    );

    liveMessages.push({
      role: "tool",
      content: output,
      toolCallId,
      timestamp: new Date().toISOString(),
      metadata,
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
