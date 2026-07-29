/**
 * Turn loop — main engine loop. Iterates inference turns.
 *
 * The loop is intentionally thin: it threads mutable per-call state
 * (live messages, token count, counters) and dispatches each iteration's
 * work to dedicated sibling helpers (`turn-loop-*.ts`).
 *
 * Invariants enforced by `turn-loop-tool-batch.ts`:
 * - Every toolCall in the saved assistant message was actually dispatched,
 *   except the `compact_committed` batch-abort path where skipped trailing
 *   calls are persisted with synthetic `batch_aborted_by_compact` results.
 * - Each toolCall has 0 or 1 tool_result in messages (0 = approval pending).
 * - "awaiting approval" state lives in approval_queue, not in messages.
 * - liveMessages always has assistant msg BEFORE tool results.
 *
 * Mission-run semantics: text from the model does NOT end the loop; it
 * continues until a stop condition, approval pause, or iteration limit.
 *
 * The only paths into compaction are:
 *   (a) the `compact_now` tool call producing a `compact_committed` engine
 *       signal (agent-driven), or
 *   (b) the runtime forced-fallback at `critical` band (deterministic safety
 *       net) — invoked both proactively at iter top AND defensively before
 *       a `paused_wake` flip when the wait window opens at critical pressure.
 */

import type { EngineContext, StopReason } from "../types.js";
import type { InferenceProvider, InferenceConfig, ToolDefinition } from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { PromptStackOptions } from "../prompts/index.js";
import logger from "@utils/logger.js";
import { executeTurn, saveAssistantMessage } from "./turn.js";
import type { TurnLoopConfig, TurnLoopResult } from "./turn-loop/state.js";
export type { TurnLoopConfig, TurnLoopResult } from "./turn-loop/state.js";
import {
  appendPendingOperatorInstructions,
  maxOperatorInstructionId,
} from "./operator-instructions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";

// Per-iteration helpers (pure async; thread state explicitly through args/returns):
import { tryCriticalBandFallback } from "./turn-loop-critical-fallback.js";
import { buildTurnPromptStack } from "./turn-loop-prompt-stack.js";
import { applyPostCompactBookkeeping } from "./turn-loop-post-compact.js";
import { processTurnToolBatch } from "./turn-loop-tool-batch.js";
import { emitTurnLoopControlState } from "./turn-loop-control-emit.js";
import { runIterationEntryGuards } from "./turn-loop-iteration-entry.js";
import { applyWaitingForWakePostBatch } from "./turn-loop-waiting-for-wake.js";
import { applyPlanAcceptancePausePostBatch } from "./turn-loop-plan-acceptance-pause.js";
import { handleTextResponse } from "./turn-loop-text-response.js";
import {
  armPostCompactBridge,
  createBandObserverWithLog,
} from "./turn-loop-state-init.js";

/**
 * Run the turn loop.
 *
 * Iterates inference turns until a stop condition or chat response.
 */
export async function runTurnLoop(
  context: EngineContext,
  messages: Message[],
  summary: string | null,
  tokenCount: number,
  provider: InferenceProvider,
  config: InferenceConfig,
  tools: ToolDefinition[],
  loopConfig: TurnLoopConfig,
  promptOptions: PromptStackOptions = {},
  abortSignal?: AbortSignal,
  // Chat-turn "stop generating" (9-5a): cancels the in-flight streaming
  // inference + persists partial text. Distinct from `abortSignal` (the
  // mission boundary stop) — only the chat ingress passes this, so
  // mission callers are behaviour-preserving.
  inferenceAbortSignal?: AbortSignal,
): Promise<TurnLoopResult> {
  let lastText: string | null = null;
  let totalToolCalls = 0;
  const pendingApprovals: string[] = [];
  let stopReason: StopReason | null = null;
  // `stoppedOnText` distinguishes "model finished cleanly" (break on text →
  // stopReason stays null) from "loop exhausted without resolution" (for
  // exits via `iteration < maxIterations` becoming false → iteration_limit).
  let stoppedOnText = false;
  const startTime = Date.now();
  let currentTokenCount = tokenCount;
  let currentSummary = summary;

  const liveMessages = [...messages];
  let lastSeenOperatorMessageId = maxOperatorInstructionId(messages);

  let postCompactBridgeRemaining = await armPostCompactBridge({
    sessionId: context.sessionId,
  });
  let criticalNoopCounter = 0;
  let skipCriticalCheckNextIter = false;
  const observeBand = createBandObserverWithLog({
    sessionId: context.sessionId,
    contextLimit: loopConfig.contextLimit,
  });

  async function mergeOperatorInstructions(): Promise<void> {
    lastSeenOperatorMessageId = await appendPendingOperatorInstructions({
      sessionId: context.sessionId,
      afterId: lastSeenOperatorMessageId,
      liveMessages,
    });
  }

  /**
   * Post-compact bookkeeping — applied after ANY committed compact (agent-
   * driven via `compact_committed` engine signal OR runtime-driven via forced
   * fallback). Bridges `applyPostCompactBookkeeping`'s pure return contract
   * with the loop's mutable closure state.
   */
  async function handlePostCompactBookkeeping(): Promise<void> {
    const updates = await applyPostCompactBookkeeping({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      liveMessages,
      lastSeenOperatorMessageId,
    });
    lastSeenOperatorMessageId = updates.nextLastSeenOperatorMessageId;
    currentSummary = updates.nextCurrentSummary;
    currentTokenCount = updates.nextCurrentTokenCount;
    postCompactBridgeRemaining = updates.nextPostCompactBridgeRemaining;
    criticalNoopCounter = updates.nextCriticalNoopCounter;
    skipCriticalCheckNextIter = updates.nextSkipCriticalCheckNextIter;
  }

  for (let iteration = 0; iteration < loopConfig.maxIterations; iteration++) {
    // Hard mission deadline — the agent-independent time-box. Checked FIRST
    // each iteration, before any other guard or inference call, so an
    // expired run stops with `deadline_reached` no matter what the agent is
    // doing. finalizeMissionRunStatus maps it to the existing terminal
    // status taxonomy (no new status) via the standard business-stop path.
    if (
      loopConfig.missionDeadlineMs != null &&
      Date.now() >= loopConfig.missionDeadlineMs
    ) {
      logger.info("engine.mission.deadline_enforced", {
        missionRunId: context.missionRunId ?? null,
        deadlineMs: loopConfig.missionDeadlineMs,
        iteration,
      });
      stopReason = "deadline_reached";
      break;
    }

    // Iteration entry: abort → observe-control → runtime-stop, in that order.
    // Helper returns the outcome; caller emits + sets stopReason + breaks.
    const entry = await runIterationEntryGuards({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      abortSignal,
      iteration,
      maxIterations: loopConfig.maxIterations,
      elapsedMs: Date.now() - startTime,
      timeoutMs: loopConfig.timeoutMs,
    });
    if (entry.kind === "abort_user_stopped") {
      stopReason = "user_stopped";
      break;
    }
    if (entry.kind === "control_paused_user") {
      await emitTurnLoopControlState(
        context.sessionId,
        context.missionRunId!,
        "paused_user",
        "user_paused",
        entry.correlationId,
      );
      stopReason = "user_paused";
      break;
    }
    if (entry.kind === "control_stopped") {
      await emitTurnLoopControlState(
        context.sessionId,
        context.missionRunId!,
        "stopped",
        "user_stopped",
        entry.correlationId,
      );
      stopReason = "user_stopped";
      break;
    }
    if (entry.kind === "runtime_stop") {
      stopReason = entry.stopReason;
      break;
    }

    // Increment iteration counter for mission runs AFTER entry guards pass.
    if (context.missionRunId) {
      await missionRunsRepo.incrementIterations(context.missionRunId);
    }

    // Critical-band forced fallback. Helper owns updateStatus → logger.error →
    // bug-emit on escalation (bit-for-bit preserved). Caller threads new
    // counter/skip-flag values and runs `handlePostCompactBookkeeping`
    // (closure-bound) on `committed`.
    let turnBand = observeBand(currentTokenCount, "iteration_start");

    const criticalOutcome = await tryCriticalBandFallback({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      turnBand,
      skipCriticalCheckNextIter,
      criticalNoopCounter,
      currentTokenCount,
      contextLimit: loopConfig.contextLimit,
    });
    switch (criticalOutcome.kind) {
      case "below_critical":
        criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
        break;
      case "skip_one_shot":
        skipCriticalCheckNextIter = criticalOutcome.nextSkipCriticalCheckNextIter;
        criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
        break;
      case "committed":
        await handlePostCompactBookkeeping();
        // Bookkeeping reset `currentTokenCount = 0`, so re-observe to drop
        // turnBand from critical → normal for this turn (P1 #2).
        turnBand = observeBand(currentTokenCount, "post_forced_fallback");
        criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
        break;
      case "noop":
        criticalNoopCounter = criticalOutcome.nextCriticalNoopCounter;
        break;
      case "escalated":
        stopReason = criticalOutcome.stopReason;
        break;
    }
    if (criticalOutcome.kind === "escalated") {
      break;
    }

    // Per-turn prompt stack (banner + resume packet + tools).
    const stack = await buildTurnPromptStack({
      context,
      turnBand,
      currentTokenCount,
      contextLimit: loopConfig.contextLimit,
      postCompactBridgeRemaining,
      basePromptOptions: promptOptions,
      baseVisibility: loopConfig.baseVisibility,
    });
    postCompactBridgeRemaining = stack.nextPostCompactBridgeRemaining;

    // Execute turn (no save yet — deferred save lives in tool-batch helper).
    // `inferenceAbortSignal` (chat-turn only) lets the streaming inference be
    // cancelled mid-response; mission callers leave it undefined.
    const turnResult = await executeTurn(
      context, liveMessages, currentSummary, provider, config, stack.tools, stack.promptOptions,
      inferenceAbortSignal,
    );
    currentTokenCount = turnResult.promptTokens;
    observeBand(currentTokenCount, "post_turn_text");

    if (abortSignal?.aborted) {
      stopReason = "user_stopped";
      break;
    }

    // Chat-turn "stop generating" (9-5a): the consumer CAPTURED the abort at
    // stream exit, so this is race-free — a turn that merely completed as the
    // user clicked stop has `inferenceAborted=false` and falls through to the
    // normal path. On a real abort, persist the partial text as a `chat_stopped`
    // row (partial tool calls were already dropped by the consumer) so the
    // ephemeral preview is replaced by a durable row.
    if (turnResult.inferenceAborted) {
      if (turnResult.content) {
        await saveAssistantMessage(context.sessionId, turnResult.content, null, {
          stopped: true,
          reasoning: turnResult.reasoning,
        });
      }
      stopReason = "user_stopped";
      break;
    }

    if (turnResult.toolCalls && turnResult.toolCalls.length > 0) {
      const batchOutcome = await processTurnToolBatch({
        context,
        turnResult: {
          content: turnResult.content,
          toolCalls: turnResult.toolCalls,
          reasoning: turnResult.reasoning,
        },
        liveMessages,
        currentTokenCount,
        contextLimit: loopConfig.contextLimit,
        lastTextSoFar: lastText,
      });
      totalToolCalls += batchOutcome.toolCallsExecuted;
      lastText = batchOutcome.lastText;

      if (batchOutcome.kind === "approval_break") {
        pendingApprovals.push(batchOutcome.pendingApprovalId);
        return {
          text: lastText,
          toolCallsMade: totalToolCalls,
          pendingApprovals,
          stopReason: "approval_required",
        };
      }
      if (batchOutcome.kind === "waiting_for_wake") {
        await applyWaitingForWakePostBatch({
          sessionId: context.sessionId,
          missionRunId: context.missionRunId ?? null,
          currentTokenCount,
          contextLimit: loopConfig.contextLimit,
          handlePostCompactBookkeeping,
        });
        stopReason = "waiting_for_wake";
        return {
          text: batchOutcome.text,
          toolCallsMade: totalToolCalls,
          pendingApprovals,
          stopReason,
          stopPayload: batchOutcome.stopPayload,
        };
      }
      if (batchOutcome.kind === "plan_acceptance_pause") {
        await applyPlanAcceptancePausePostBatch({
          missionRunId: context.missionRunId ?? null,
        });
        stopReason = "plan_acceptance_required";
        return {
          text: batchOutcome.text,
          toolCallsMade: totalToolCalls,
          pendingApprovals,
          stopReason,
          stopPayload: batchOutcome.stopPayload,
        };
      }
      if (batchOutcome.kind === "engine_stop") {
        stopReason = batchOutcome.stopReason;
        return {
          text: batchOutcome.text,
          toolCallsMade: totalToolCalls,
          pendingApprovals,
          stopReason,
          stopPayload: batchOutcome.stopPayload,
        };
      }
      if (batchOutcome.kind === "compact_committed") {
        await handlePostCompactBookkeeping();
        continue;
      }

      // Normal batch complete
      await mergeOperatorInstructions();
      continue;
    }

    if (turnResult.content) {
      lastText = turnResult.content;
      const textOutcome = await handleTextResponse({
        context,
        liveMessages,
        content: turnResult.content,
        reasoning: turnResult.reasoning,
        mergeOperatorInstructions,
      });
      if (textOutcome.kind === "mission_run_continue") {
        continue;
      }
      stoppedOnText = true;
      break;
    }
  }

  // If the for-loop exhausted maxIterations without either an explicit stop OR
  // a natural text-break (agent/setup), surface it as `iteration_limit` so every
  // transport can see why.
  if (!stopReason && !stoppedOnText) {
    stopReason = "iteration_limit";
  }

  return { text: lastText, toolCallsMade: totalToolCalls, pendingApprovals, stopReason };
}
