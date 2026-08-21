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
 *   (a) runtime-automatic background PREPARATION at the `warning` band, forked
 *       by an iteration-boundary action. It only creates the frozen input; the
 *       cutover is a separate, explicitly requested step and never happens
 *       inside the trigger.
 *   (b) the queued APPLY consumed at the iteration boundary — requested by the
 *       `CompactApply` tool, the UI button, or the Full-Autonomous auto-apply.
 *   (c) the critical-band ladder (`critical-compaction.ts`): forced prepared
 *       apply, else the deterministic LLM-free fallback. Invoked proactively at
 *       iteration top, defensively before a `paused_wake` park, and on a
 *       pre-inference byte-ceiling breach.
 *
 * Pre-inference byte ceiling (C8): while a live preparation suppresses the
 * 0.88 barrier, the thing that normally stops the tape outgrowing the window is
 * switched off — so every inference on that path is first bounded. The loop
 * builds the request envelope and MEASURES THAT OBJECT, then hands the very
 * same object to `executeTurn`. `buildTurnEnvelope` is not reproducible (the
 * turn-state segment embeds the current time), so measuring one build and
 * sending another would make the ceiling a claim about a request nobody issued.
 */

import type { EngineContext, StopReason } from "../types.js";
import type { InferenceProvider, InferenceConfig, ToolDefinition } from "@vex-agent/inference/types.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { PromptStackOptions } from "../prompts/index.js";
import logger from "@utils/logger.js";
import { executeTurn, saveAssistantMessage } from "./turn.js";
import { buildTurnEnvelope } from "./turn-envelope.js";
import { checkPreInferenceGate } from "./turn-loop/pre-inference-ceiling.js";
import { resolvePreparationPressureState } from "./preparation-pressure-state.js";
import { getLivePreparationPressureState } from "@vex-agent/db/repos/compaction-preparations/index.js";
import { SUMMARY_CALL_TIMEOUT_MS } from "@vex-agent/engine/compaction/policy.js";
import {
  streamDeltaBus,
  toStreamAbortedEvent,
} from "@vex-agent/engine/events/index.js";
import type { TurnLoopConfig, TurnLoopResult } from "./turn-loop/state.js";
export type { TurnLoopConfig, TurnLoopResult } from "./turn-loop/state.js";
import {
  appendPendingOperatorInstructions,
  maxOperatorInstructionId,
} from "./operator-instructions.js";
import * as missionRunsRepo from "@vex-agent/db/repos/mission-runs.js";

// Per-iteration helpers (pure async; thread state explicitly through args/returns):
import { runCriticalBandStep } from "./turn-loop/critical-band-step.js";
import { buildTurnPromptStack } from "./turn-loop-prompt-stack.js";
import { applyPostCompactBookkeeping } from "./turn-loop-post-compact.js";
import { processTurnToolBatch } from "./turn-loop-tool-batch.js";
import { runIterationEntryGuards } from "./turn-loop-iteration-entry.js";
import { resolveEffectiveInferenceConfig } from "./turn-loop/effective-inference-config.js";
import { buildIterationBoundaryActions } from "./turn-loop/iteration-boundary-actions.js";
import { applyIterationEntryOutcome } from "./turn-loop/iteration-entry-outcome.js";
import { applyToolBatchOutcome } from "./turn-loop/tool-batch-step.js";
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
  // Re-resolved per iteration — failover can change window AND price mid-run.
  let active = { config, contextLimit: loopConfig.contextLimit };
  const observeBand = createBandObserverWithLog({
    sessionId: context.sessionId,
    contextLimit: () => active.contextLimit,
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
    active = await resolveEffectiveInferenceConfig(config, loopConfig.contextLimit, context.sessionId, provider);
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

    // Iteration entry: abort → observe-control → runtime-stop → boundary
    // actions, in that order. Helper returns the outcome; caller emits + sets
    // stopReason + breaks.
    const entry = await runIterationEntryGuards({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      abortSignal,
      iteration,
      maxIterations: loopConfig.maxIterations,
      elapsedMs: Date.now() - startTime,
      timeoutMs: loopConfig.timeoutMs,
      boundaryActions: buildIterationBoundaryActions({
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        sessionPermission: context.sessionPermission,
        runnerOwnerId: loopConfig.runnerOwnerId,
        tokenCount: currentTokenCount,
        contextLimit: active.contextLimit,
      }),
    });
    const entryStep = await applyIterationEntryOutcome({
      entry,
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      handlePostCompactBookkeeping,
    });
    if (entryStep.kind === "stop") {
      stopReason = entryStep.stopReason;
      break;
    }

    // Increment iteration counter for mission runs AFTER entry guards pass.
    if (context.missionRunId) {
      await missionRunsRepo.incrementIterations(context.missionRunId);
    }

    // Critical-band forced fallback — band observation + ladder + counter
    // reduction. See `turn-loop/critical-band-step.ts`.
    const criticalStep = await runCriticalBandStep({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      sessionPermission: context.sessionPermission,
      runnerOwnerId: loopConfig.runnerOwnerId,
      contextLimit: active.contextLimit,
      criticalNoopCounter,
      skipCriticalCheckNextIter,
      observeBand,
      readCurrentTokenCount: () => currentTokenCount,
      handlePostCompactBookkeeping,
    });
    if (criticalStep.kind === "stop") {
      stopReason = criticalStep.stopReason;
      break;
    }
    const turnBand = criticalStep.turnBand;
    criticalNoopCounter = criticalStep.criticalNoopCounter;
    skipCriticalCheckNextIter = criticalStep.skipCriticalCheckNextIter;

    // THE per-turn compaction-preparation read — exactly one, feeding three
    // consumers that must agree: the pressure banner's copy, the tool
    // visibility axes (barrier bypass + `CompactApply`), and the byte ceiling
    // below. Fail-closed: an unreadable state resolves to `none`, which denies
    // the bypass and hides the apply tool.
    const preparationState = await resolvePreparationPressureState(
      context.sessionId,
      (sessionId) =>
        getLivePreparationPressureState(sessionId, SUMMARY_CALL_TIMEOUT_MS),
    );

    // Per-turn prompt stack (banner + resume packet + tools).
    const stack = await buildTurnPromptStack({
      context,
      turnBand,
      currentTokenCount,
      contextLimit: active.contextLimit,
      postCompactBridgeRemaining,
      basePromptOptions: promptOptions,
      baseVisibility: loopConfig.baseVisibility,
      preparationState,
    });
    postCompactBridgeRemaining = stack.nextPostCompactBridgeRemaining;

    // Build the request envelope ONCE, here, so the ceiling below measures the
    // object that is then sent (see the module header — it is not reproducible).
    const envelope = buildTurnEnvelope(
      context, liveMessages, currentSummary, stack.promptOptions,
    );

    // ── Pre-inference byte ceiling (C8) ─────────────────────────────
    // Runs only while the barrier is bypassed. On a breach the request is
    // NEVER issued — every arm below either restarts the iteration or breaks.
    const gate = await checkPreInferenceGate({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      sessionPermission: context.sessionPermission,
      preparationBypassesBarrier: stack.preparationBypassesBarrier,
      providerMessages: envelope.providerMessages,
      tools: stack.tools,
      config: active.config,
      contextLimit: active.contextLimit,
      currentTokenCount,
      criticalNoopCounter,
      runnerOwnerId: loopConfig.runnerOwnerId,
    });
    if (gate.kind === "escalated") {
      stopReason = gate.stopReason;
      break;
    }
    if (gate.kind === "retry_iteration") {
      criticalNoopCounter = gate.nextCriticalNoopCounter;
      if (gate.committed) await handlePostCompactBookkeeping();
      continue;
    }

    // Execute turn (no save yet — deferred save lives in tool-batch helper).
    // `inferenceAbortSignal` (chat-turn only) lets the streaming inference be
    // cancelled mid-response; mission callers leave it undefined.
    const turnResult = await executeTurn(
      context, liveMessages, currentSummary, provider, active.config, stack.tools, stack.promptOptions,
      inferenceAbortSignal,
      // THE measured object, not a rebuild.
      envelope,
    );
    currentTokenCount = turnResult.promptTokens;
    observeBand(currentTokenCount, "post_turn_text");

    // Stop-during-inference (9-5a): the consumer CAPTURED the abort at stream
    // exit, so this is race-free — a turn that merely completed as the user
    // clicked stop has `inferenceAborted=false` and falls through. On a real
    // abort, persist the partial text as a `chat_stopped` row (partial tool
    // calls were already dropped by the consumer) so the ephemeral preview is
    // replaced by a durable row.
    //
    // Checked BEFORE the bare `abortSignal` break: mission runs now pass the
    // same signal in BOTH positions, so an operator Stop cancels the stream
    // and MUST still persist what the model had produced. Testing the boundary
    // flag first would silently drop that partial row.
    if (turnResult.inferenceAborted) {
      if (turnResult.content) {
        // Non-empty partial output becomes a durable `chat_stopped` row. Its
        // `transcriptAppend` is what retires the live preview — the same
        // handoff every ordinary turn uses. Emitting a terminal stream delta
        // here as well would clear the preview BEFORE this row is refetched,
        // which is precisely the swap gap the preview machinery exists to
        // avoid. So: persist, and stay quiet on the stream channel.
        await saveAssistantMessage(context.sessionId, turnResult.content, null, {
          stopped: true,
          reasoning: turnResult.reasoning,
        });
      } else {
        // Nothing was persisted and nothing ever will be for this stream, so
        // no `transcriptAppend` is coming. Without a terminal delta the
        // preview would sit frozen until the 60 s orphan timer. Correlated by
        // `streamId` so a consumer clears exactly this stream and never a
        // newer one that started in between.
        //
        // Best-effort, like every emission on this bus: listener errors are
        // isolated by the bus and a preview signal must never break the turn.
        //
        // NOTE (kept inline deliberately): the emit site is pinned at
        // SOURCE level to this file by
        // `src/__tests__/vex-agent/engine/events/stream-aborted-delta.test.ts`
        // — the decision of who owns the emit is itself the contract, so this
        // block must not be extracted into a sibling helper.
        streamDeltaBus.emit(
          toStreamAbortedEvent(
            context.sessionId,
            turnResult.streamId,
            turnResult.nextStreamSequence,
          ),
        );
      }
      stopReason = "user_stopped";
      break;
    }

    // Boundary stop with a turn that completed anyway (nothing to persist —
    // the normal text/tool paths below are what would have saved it).
    if (abortSignal?.aborted) {
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
        contextLimit: active.contextLimit,
        // Same decision the catalog was projected from — never recomputed.
        preparationBypassesBarrier: stack.preparationBypassesBarrier,
        lastTextSoFar: lastText,
        // Stop must be felt inside a multi-tool batch, not only at the next
        // iteration boundary. Mission runs thread the run's abort signal
        // (pos 10); chat turns only ever get the "stop generating" inference
        // signal (pos 11), so fall back to it. The batch checks this at the
        // TOP of each call — never mid-dispatch.
        abortSignal: abortSignal ?? inferenceAbortSignal,
        // Both wall-clock bounds as absolute epochs, so the batch can observe
        // them between calls. The iteration-boundary checks above stay exactly
        // as they were — this only bounds the overshoot WITHIN one batch.
        deadlines: {
          turnTimeoutAtMs: startTime + loopConfig.timeoutMs,
          missionDeadlineAtMs: loopConfig.missionDeadlineMs ?? null,
        },
      });
      totalToolCalls += batchOutcome.toolCallsExecuted;
      lastText = batchOutcome.lastText;

      const batchStep = await applyToolBatchOutcome({
        batchOutcome,
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        sessionPermission: context.sessionPermission,
        runnerOwnerId: loopConfig.runnerOwnerId,
        currentTokenCount,
        contextLimit: active.contextLimit,
        totalToolCalls,
        pendingApprovals,
        lastText,
        handlePostCompactBookkeeping,
        mergeOperatorInstructions,
      });
      if (batchStep.kind === "return") {
        return batchStep.result;
      }
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
