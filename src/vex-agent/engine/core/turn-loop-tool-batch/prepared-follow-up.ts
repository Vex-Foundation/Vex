/** Trusted, one-hop prepared-action dispatch inside a tool batch. */

import { randomUUID } from "node:crypto";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { ParsedToolCall } from "@vex-agent/inference/types.js";
import { dispatchTool } from "@vex-agent/tools/dispatcher.js";
import type { InternalToolContext } from "@vex-agent/tools/internal/types.js";
import { resolveInjectedProtocolTool } from "@vex-agent/tools/registry/injected-protocol-tools.js";
import { resolveToolName } from "@vex-agent/tools/registry/name-resolution.js";
import {
  validatePreparedActionFollowUp,
  type ValidatedPreparedActionFollowUp,
} from "@vex-agent/tools/registry/prepared-action-follow-ups.js";
import type { ToolResult } from "@vex-agent/tools/types.js";
import { deriveExplorerRefs, type ExplorerRef } from "../explorer-refs.js";
import { displayStatusPayload } from "../tool-display-status.js";
import type { EngineContext } from "../../types.js";
import logger from "@utils/logger.js";
import {
  assertApprovalActionKind,
  enqueueApprovalIntent,
} from "./approval-stop.js";
import type { ToolBatchOutcome } from "./outcome.js";
import {
  APPROVAL_AUTO_REJECTED_RUN_TERMINAL_OUTPUT,
  APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT,
  mapBatchOutcome,
  persistBatchTranscript,
} from "./results.js";

export interface PreparedFollowUpResolution {
  readonly resultForTranscript: ToolResult;
  readonly followUp: ValidatedPreparedActionFollowUp | null;
}

const SAFE_DIAGNOSTIC_TOOL_ID_RE = /^[A-Za-z][A-Za-z0-9._-]{0,127}$/;

/**
 * Resolve the model-visible source projection to the immutable identity used by
 * the trusted handoff registry. Protocol public names are catalog projections
 * and may change; their dotted toolId is the durable identity. Internal tools
 * keep their canonical registered name as identity.
 *
 * `execute_tool` is retained only as a structural legacy envelope. Its source
 * identity comes from its explicit `args.toolId`; the bare wrapper name never
 * authorizes a follow-up by itself.
 */
export function resolvePreparedActionSourceIdentity(
  sourceCall: Pick<ParsedToolCall, "name" | "arguments">,
): string {
  const canonicalName = resolveToolName(sourceCall.name);
  if (canonicalName === "execute_tool") {
    return typeof sourceCall.arguments.toolId === "string"
      ? sourceCall.arguments.toolId
      : "unknown.execute_tool.source";
  }
  return resolveInjectedProtocolTool(canonicalName)?.toolId ?? canonicalName;
}

/** Validate the handler contract; unknown or malformed mappings fail closed. */
export function resolvePreparedActionFollowUp(
  sourceCall: Pick<ParsedToolCall, "name" | "arguments">,
  result: ToolResult,
): PreparedFollowUpResolution {
  const candidate = result.preparedActionFollowUp;
  if (candidate === undefined) {
    return { resultForTranscript: result, followUp: null };
  }
  const sourceIdentity = resolvePreparedActionSourceIdentity(sourceCall);
  const validation = result.success
    ? validatePreparedActionFollowUp(sourceIdentity, candidate)
    : null;
  if (validation === null || !validation.ok) {
    const reason = validation?.reason ?? "source_result_failed";
    const targetToolId = typeof candidate.args.toolId === "string"
      ? candidate.args.toolId
      : candidate.toolName;
    // SAFE DIAGNOSTICS ONLY. Tool identities and the bounded reason enum are
    // catalog metadata. Never log the candidate args or approval preview: those
    // may contain amounts, wallet addresses, route identity, or fee details.
    logger.warn("engine.prepared_action_follow_up.rejected", {
      reason,
      sourceToolId: safeDiagnosticToolIdentity(sourceIdentity),
      targetToolId: safeDiagnosticToolIdentity(targetToolId),
    });
    const output = reason === "unknown_mapping"
      ? "Prepared-action follow-up rejected by the trusted registry because the internal approval mapping is unavailable. The preparation may have been saved, but no approval card or automatic action was dispatched."
      : reason === "invalid_contract"
        ? "Prepared-action follow-up rejected by the trusted registry because the prepared details failed a safety consistency check. No approval card or automatic action was dispatched."
        : "Prepared-action follow-up rejected because the preparation step did not complete successfully. No approval card or automatic action was dispatched.";
    return {
      resultForTranscript: {
        ...result,
        success: false,
        output,
        preparedActionFollowUp: undefined,
      },
      followUp: null,
    };
  }
  return { resultForTranscript: result, followUp: validation.followUp };
}

function safeDiagnosticToolIdentity(value: unknown): string {
  return typeof value === "string" && SAFE_DIAGNOSTIC_TOOL_ID_RE.test(value)
    ? value
    : "unknown";
}

/**
 * Persist prepare, synthesize and dispatch confirm, then either enqueue the
 * existing approval flow or persist the immediate full-permission result.
 */
export async function dispatchPreparedActionFollowUp(args: {
  readonly context: EngineContext;
  readonly toolContext: InternalToolContext;
  readonly content: string | null;
  /** Provider reasoning trace of the model turn that emitted the prepare call. */
  readonly reasoning: string | null;
  readonly executedCalls: ParsedToolCall[];
  /**
   * Structurally the orchestrator's `ExecutedResult`, re-declared inline here.
   * `durationMs` is optional for the same reason as there: absent when the
   * entry never executed, never `0`.
   */
  readonly executedResults: Array<{
    readonly toolCallId: string;
    readonly toolName: string;
    readonly output: string;
    readonly success: boolean;
    readonly explorerRefs: readonly ExplorerRef[];
    readonly durationMs?: number;
  }>;
  readonly liveMessages: Message[];
  readonly followUp: ValidatedPreparedActionFollowUp;
  readonly toolCallsExecuted: number;
  readonly lastText: string | null;
  /**
   * Operator Stop. Re-checked here because this module dispatches the leg that
   * SIGNS, and the caller's check happens before a transcript write that is a
   * real window. Never checked mid-dispatch — a call in flight always finishes.
   */
  readonly abortSignal?: AbortSignal;
}): Promise<ToolBatchOutcome> {
  await persistBatchTranscript({
    sessionId: args.context.sessionId,
    content: args.content,
    executedCalls: args.executedCalls,
    executedResults: args.executedResults,
    liveMessages: args.liveMessages,
    reasoning: args.reasoning,
  });

  // ── Stop check immediately BEFORE the signing dispatch ──
  // The prepare above is already persisted, so the transcript is balanced.
  // The confirm was synthesized by the engine and never emitted by the model,
  // so there is nothing to pair: simply do not dispatch it. The underlying
  // wallet intent expires on its own; nothing is signed and nothing broadcast.
  if (args.abortSignal?.aborted) {
    return mapBatchOutcome({
      batchStopReason: "user_stopped",
      batchStopOutput: null,
      batchStopPayload: undefined,
      compactCommittedThisBatch: false,
      approvalId: null,
      toolCallsExecuted: args.toolCallsExecuted,
      lastText: args.lastText,
    });
  }

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
    {
      ...args.toolContext,
      modelOriginated: undefined,
    },
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
    // ── Stop check AFTER the confirm returned, before the enqueue ──
    // The dispatch was allowed to finish, but a Stop that landed while it was
    // in flight must not leave a live, approvable wallet action parked on a
    // run the operator just ended. Nothing executed (that is what
    // `pendingApproval` means), so pairing the synthetic call with a truthful
    // "no approval was created" result is the complete record.
    if (args.abortSignal?.aborted) {
      await persistBatchTranscript({
        sessionId: args.context.sessionId,
        content: null,
        executedCalls: [syntheticCall],
        executedResults: [
          {
            toolCallId: syntheticCall.id,
            toolName: syntheticCall.name,
            output: APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT,
            success: false,
            explorerRefs: [],
          },
        ],
        liveMessages: args.liveMessages,
        systemOriginated: true,
      });
      return mapBatchOutcome({
        batchStopReason: "user_stopped",
        batchStopOutput: APPROVAL_SKIPPED_BY_USER_STOP_OUTPUT,
        batchStopPayload: undefined,
        compactCommittedThisBatch: false,
        approvalId: null,
        toolCallsExecuted,
        lastText: args.lastText,
      });
    }
    const intentActionKind = assertApprovalActionKind(result, syntheticCall);
    const enqueueOutcome = await enqueueApprovalIntent({
      context: args.context,
      toolCall: syntheticCall,
      result,
      toolContext: args.toolContext,
      intentActionKind,
      trustedPreview: args.followUp.approvalPreview,
      trustedExpiresAt: args.followUp.expiresAt,
    });
    if (enqueueOutcome.kind === "auto_rejected") {
      // The run went terminal while the prepared action was in flight, so the
      // approval was rejected inside the enqueue transaction rather than
      // parked on a dead run. Persist a paired result and end the batch on
      // the existing `user_stopped` reason.
      await persistBatchTranscript({
        sessionId: args.context.sessionId,
        content: null,
        executedCalls: [syntheticCall],
        executedResults: [
          {
            toolCallId: syntheticCall.id,
            toolName: syntheticCall.name,
            output: APPROVAL_AUTO_REJECTED_RUN_TERMINAL_OUTPUT,
            success: false,
            explorerRefs: [],
          },
        ],
        liveMessages: args.liveMessages,
        systemOriginated: true,
      });
      return mapBatchOutcome({
        batchStopReason: "user_stopped",
        batchStopOutput: APPROVAL_AUTO_REJECTED_RUN_TERMINAL_OUTPUT,
        batchStopPayload: undefined,
        compactCommittedThisBatch: false,
        approvalId: null,
        toolCallsExecuted,
        lastText: args.lastText,
      });
    }
    // System-originated: this call was synthesized by the engine from a
    // validated prepared-action contract, never produced by the model. The
    // provenance stamp (source:"engine" + a distinct messageType) lives in
    // `saveAssistantMessage` / `persistBatchTranscript` so an auditor
    // reading `messages` directly can never mistake it for model output.
    await persistBatchTranscript({
      sessionId: args.context.sessionId,
      content: null,
      executedCalls: [syntheticCall],
      executedResults: [],
      liveMessages: args.liveMessages,
      systemOriginated: true,
    });
    return mapBatchOutcome({
      batchStopReason: "approval_required",
      batchStopOutput: null,
      batchStopPayload: undefined,
      compactCommittedThisBatch: false,
      approvalId: enqueueOutcome.approvalId,
      toolCallsExecuted,
      lastText: args.lastText,
    });
  }

  await persistBatchTranscript({
    sessionId: args.context.sessionId,
    content: null,
    executedCalls: [syntheticCall],
    executedResults: [
      {
        toolCallId: syntheticCall.id,
        toolName: syntheticCall.name,
        output: result.output,
        success: result.success,
        explorerRefs: deriveExplorerRefs(result.data),
        ...(result.durationMs !== undefined ? { durationMs: result.durationMs } : {}),
        // DISPLAY-only axis: a prepared-action confirm IS a money move, so an
        // ambiguous broadcast here is exactly the case the pending chip exists
        // for. `success` is untouched.
        ...displayStatusPayload(result.data),
      },
    ],
    liveMessages: args.liveMessages,
    systemOriginated: true,
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
