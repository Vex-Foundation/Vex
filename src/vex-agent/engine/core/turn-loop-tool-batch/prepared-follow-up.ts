/** Trusted, one-hop prepared-action dispatch inside a tool batch. */

import { randomUUID } from "node:crypto";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import {
  validatePreparedActionFollowUp,
  type ValidatedPreparedActionFollowUp,
} from "@vex-agent/tools/registry/prepared-action-follow-ups.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import type { EngineContext } from "../../types.js";
import {
  assertApprovalActionKind,
  enqueueApprovalIntent,
} from "./approval-stop.js";
import type { ToolBatchOutcome } from "./outcome.js";
import { mapBatchOutcome, persistBatchTranscript } from "./results.js";

export interface PreparedFollowUpResolution {
  readonly resultForTranscript: ToolResult;
  readonly followUp: ValidatedPreparedActionFollowUp | null;
}

/** Validate the handler contract; unknown or malformed mappings fail closed. */
export function resolvePreparedActionFollowUp(
  sourceToolName: string,
  result: ToolResult,
): PreparedFollowUpResolution {
  const candidate = result.preparedActionFollowUp;
  if (candidate === undefined) {
    return { resultForTranscript: result, followUp: null };
  }
  const validation = result.success
    ? validatePreparedActionFollowUp(sourceToolName, candidate)
    : null;
  if (validation === null || !validation.ok) {
    return {
      resultForTranscript: {
        ...result,
        success: false,
        output:
          "Prepared-action follow-up rejected by the trusted registry; no automatic action was dispatched.",
        preparedActionFollowUp: undefined,
      },
      followUp: null,
    };
  }
  return { resultForTranscript: result, followUp: validation.followUp };
}

/**
 * Persist prepare, synthesize and dispatch confirm, then either enqueue the
 * existing approval flow or persist the immediate full-permission result.
 */
export async function dispatchPreparedActionFollowUp(args: {
  readonly context: EngineContext;
  readonly toolContext: InternalToolContext;
  readonly content: string | null;
  readonly executedCalls: ParsedToolCall[];
  readonly executedResults: Array<{
    readonly toolCallId: string;
    readonly toolName: string;
    readonly output: string;
    readonly success: boolean;
  }>;
  readonly liveMessages: Message[];
  readonly followUp: ValidatedPreparedActionFollowUp;
  readonly toolCallsExecuted: number;
  readonly lastText: string | null;
}): Promise<ToolBatchOutcome> {
  await persistBatchTranscript({
    sessionId: args.context.sessionId,
    content: args.content,
    executedCalls: args.executedCalls,
    executedResults: args.executedResults,
    liveMessages: args.liveMessages,
  });

  const syntheticCall: ParsedToolCall = {
    id: `prepared-follow-up-${randomUUID()}`,
    name: args.followUp.toolName,
    arguments: args.followUp.args,
  };
  let result = await dispatchTool(
    {
      name: syntheticCall.name,
      args: syntheticCall.arguments,
      toolCallId: syntheticCall.id,
    },
    args.toolContext,
  );

  // Only one trusted hop is permitted. Never dispatch recursively.
  if (result.preparedActionFollowUp !== undefined) {
    result = {
      ...result,
      success: false,
      pendingApproval: false,
      output:
        "Recursive prepared-action follow-up rejected; no additional action was dispatched.",
      preparedActionFollowUp: undefined,
    };
  }

  const toolCallsExecuted = args.toolCallsExecuted + 1;
  if (result.pendingApproval) {
    const intentActionKind = assertApprovalActionKind(result, syntheticCall);
    const approvalId = await enqueueApprovalIntent({
      context: args.context,
      toolCall: syntheticCall,
      result,
      toolContext: args.toolContext,
      intentActionKind,
      trustedPreview: args.followUp.approvalPreview,
      trustedExpiresAt: args.followUp.expiresAt,
    });
    await persistBatchTranscript({
      sessionId: args.context.sessionId,
      content: null,
      executedCalls: [syntheticCall],
      executedResults: [],
      liveMessages: args.liveMessages,
    });
    return mapBatchOutcome({
      batchStopReason: "approval_required",
      batchStopOutput: null,
      batchStopPayload: undefined,
      compactCommittedThisBatch: false,
      approvalId,
      toolCallsExecuted,
      lastText: args.lastText,
    });
  }

  await persistBatchTranscript({
    sessionId: args.context.sessionId,
    content: null,
    executedCalls: [syntheticCall],
    executedResults: [{
      toolCallId: syntheticCall.id,
      toolName: syntheticCall.name,
      output: result.output,
      success: result.success,
    }],
    liveMessages: args.liveMessages,
  });
  return mapBatchOutcome({
    batchStopReason: null,
    batchStopOutput: null,
    batchStopPayload: undefined,
    compactCommittedThisBatch: false,
    approvalId: null,
    toolCallsExecuted,
    lastText: args.lastText,
  });
}
