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
 * Two INDEPENDENT bounds guard the loop and must not be conflated:
 * - `loopConfig.maxIterations` bounds how much WORK a turn may do. A round
 *   batching six tool calls costs one unit.
 * - `MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS` bounds how many times in a row the
 *   model may answer with nothing at all, and is RESET by every productive
 *   round. See `runner/unproductive-rounds.ts`.
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

import { randomUUID } from "node:crypto";
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
import {
  insertTurnRunTiming,
  recordInBackground,
} from "@vex-agent/db/repos/runtime-timings.js";
import { classifyInferenceError } from "@vex-agent/inference/attempt-timing.js";
import { withPersistTiming } from "./turn-loop/persist-timing.js";
import { createReasoningReplayStore } from "./turn-loop/reasoning-replay-store.js";
import { REASONING_REPLAY_ENABLED } from "@vex-agent/inference/openrouter/reasoning-replay.js";

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
import { applyWaitingForWakePostBatch } from "./turn-loop-waiting-for-wake.js";
import { resolveToolName } from "@vex-agent/tools/registry/name-resolution.js";
import { handleTextResponse, persistTextAnswer } from "./turn-loop-text-response.js";
import {
  CUTOFF_ANSWER_SUFFIX,
  CUTOFF_CONTINUATION_ENABLED,
  CUTOFF_CONTINUATION_NOTE,
  continuationMessages,
  detectCutOffAnswer,
  resolveCutoffContinuation,
  stoppedCutoffContent,
  stoppedCutoffReasoning,
  type CutOffAnswer,
} from "./runner/cutoff-continuation.js";
import {
  beginPresentationScope,
  endPresentationScope,
} from "./board-presentation.js";
import {
  armPostCompactBridge,
  createBandObserverWithLog,
} from "./turn-loop-state-init.js";
import {
  MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS,
  classifyInferenceRound,
  type InferenceRoundClassification,
  type UnproductiveRoundKind,
} from "./runner/unproductive-rounds.js";
import { createToolCallLoopDetector } from "./runner/tool-call-loop-detector.js";
import {
  STALL_RECOVERY_ENABLED,
  createStallRecoveryTracker,
  prepareStallRecoveryCall,
  stallRecoveryLogFields,
  type StallRecoveryCall,
} from "./runner/stall-recovery.js";
import { hasPendingForSession } from "@vex-agent/db/repos/approvals.js";
import { decidePromiseNudge, PROMISE_NUDGE_NOTE } from "./runner/promise-nudge.js";
import { isLeaseLost } from "../runtime/lease-guard.js";
import { reconcileAfterTakeover } from "./turn-loop/takeover-reconcile.js";

/**
 * The inference call is aborted by EITHER the caller's inference signal (the
 * Stop) or the runner's lease-lost signal. Only the inference: the combined
 * signal is never handed to a tool, and the loop tells the two causes apart
 * afterwards by reading each signal on its own.
 */
function inferenceSignalFor(
  inferenceAbortSignal: AbortSignal | undefined,
  leaseLostSignal: AbortSignal | undefined,
): AbortSignal | undefined {
  if (leaseLostSignal === undefined) return inferenceAbortSignal;
  if (inferenceAbortSignal === undefined) return leaseLostSignal;
  return AbortSignal.any([inferenceAbortSignal, leaseLostSignal]);
}

/**
 * Runtime-measurement state for one `runTurnLoop` invocation (Kairos Phase 1).
 * `progress` is written by the loop as it goes so the wrapper can still report
 * how far a turn got when it throws. `persistMs` is accumulated by the
 * transcript write sites through the `withPersistTiming` scope.
 */
interface TurnRunTelemetry {
  readonly turnRunId: string;
  readonly progress: { iterationsUsed: number; toolCallsMade: number; persistMs: number };
}

/**
 * Run the turn loop.
 *
 * Iterates inference turns until a stop condition or chat response.
 *
 * This wrapper only measures: it tags the invocation with a `turnRunId` that
 * every inference attempt and tool dispatch of this turn carries, and writes
 * one `turn_run_timings` row in the background once the loop returns or
 * throws. The result and any error pass through untouched.
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
  const run: TurnRunTelemetry = {
    turnRunId: randomUUID(),
    progress: { iterationsUsed: 0, toolCallsMade: 0, persistMs: 0 },
  };
  const startedAt = new Date();
  const startedAtMs = performance.now();
  let result: TurnLoopResult | undefined;
  let error: unknown;
  try {
    result = await withPersistTiming(run.progress, () => runTurnLoopBody(
      context, messages, summary, tokenCount, provider, config, tools, loopConfig,
      promptOptions, abortSignal, inferenceAbortSignal, run,
    ));
    return result;
  } catch (err) {
    error = err;
    throw err;
  } finally {
    recordTurnRunTiming(
      context, run, startedAt, performance.now() - startedAtMs,
      preLoopSetupMs(loopConfig.entryStartedAtMs, startedAtMs), result, error,
    );
  }
}

/**
 * Entry point start → loop start, or null when the caller supplied no entry
 * timestamp (or one that is not a usable monotonic reading).
 */
function preLoopSetupMs(entryStartedAtMs: number | undefined, loopStartedAtMs: number): number | null {
  if (entryStartedAtMs === undefined || !Number.isFinite(entryStartedAtMs)) return null;
  return Math.max(0, loopStartedAtMs - entryStartedAtMs);
}

/**
 * Write the `turn_run_timings` row. Fire-and-forget and never throws, so it
 * cannot change what `runTurnLoop` returns or throws. Sanitised: counts, the
 * stop reason enum, and `classifyInferenceError`'s label - never message text.
 */
function recordTurnRunTiming(
  context: EngineContext,
  run: TurnRunTelemetry,
  startedAt: Date,
  totalMs: number,
  preLoopSetupMs: number | null,
  result: TurnLoopResult | undefined,
  error: unknown,
): void {
  try {
    const row = {
      turnRunId: run.turnRunId,
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      sessionKind: context.sessionKind ?? null,
      startedAt,
      totalMs,
      iterations: run.progress.iterationsUsed,
      toolCalls: result?.toolCallsMade ?? run.progress.toolCallsMade,
      preLoopSetupMs,
      persistMs: run.progress.persistMs,
      outcome: result === undefined ? ("error" as const) : ("returned" as const),
      stopReason: result?.stopReason ?? null,
      errorClass: result === undefined ? classifyInferenceError(error) : null,
    };
    recordInBackground("turn_run", () => insertTurnRunTiming(row));
  } catch {
    // Telemetry must never change what the turn returns or throws.
  }
}

async function runTurnLoopBody(
  context: EngineContext,
  messages: Message[],
  summary: string | null,
  tokenCount: number,
  provider: InferenceProvider,
  config: InferenceConfig,
  tools: ToolDefinition[],
  loopConfig: TurnLoopConfig,
  promptOptions: PromptStackOptions,
  abortSignal: AbortSignal | undefined,
  inferenceAbortSignal: AbortSignal | undefined,
  run: TurnRunTelemetry,
): Promise<TurnLoopResult> {
  let lastText: string | null = null;
  let totalToolCalls = 0;
  const pendingApprovals: string[] = [];
  let stopReason: StopReason | null = null;
  // `stoppedOnText` distinguishes "model finished cleanly" (break on text →
  // stopReason stays null) from "loop exhausted without resolution" (for
  // exits via `iteration < maxIterations` becoming false → iteration_limit).
  let stoppedOnText = false;
  // STALL detector, not a budget. Counts rounds that emitted neither text nor a
  // complete tool batch; reset by every productive round. See
  // `runner/unproductive-rounds.ts` for why it must stay separate from
  // `maxIterations` and why the bound is small.
  let consecutiveUnproductiveRounds = 0;
  // Class of the most recent unproductive round, reported when the stall bound
  // fires so the stop says HOW the model stalled, not only that it did.
  let lastUnproductiveKind: UnproductiveRoundKind | null = null;
  // One recovery call per stall streak instead of an identical replay: a
  // one-shot turn-state note plus, where safe, lower effort for that call
  // only. See `runner/stall-recovery.ts`.
  const stallRecovery = createStallRecoveryTracker(STALL_RECOVERY_ENABLED);
  // Provider reasoning handed back within THIS run's tool loop (Kairos R-7).
  // Memory only and scoped to this loop; switched off it records nothing and
  // leaves every envelope untouched. See `turn-loop/reasoning-replay-store.ts`.
  const reasoningReplay = createReasoningReplayStore(REASONING_REPLAY_ENABLED);
  // A text answer the output limit cut short, held back (not persisted) while
  // ONE continuation call finishes it. See `runner/cutoff-continuation.ts`.
  let cutoff: CutOffAnswer | null = null;
  // REPETITION detector, and a third bound distinct from both of the above:
  // `maxIterations` counts work, `consecutiveUnproductiveRounds` counts
  // silence, this counts a model doing the same productive thing forever. Its
  // lifetime is exactly this turn loop, which is what lets the graduated second
  // strike land on a LATER round than the correction that preceded it, while
  // never carrying one turn's history into the next. See
  // `runner/tool-call-loop-detector.ts`.
  const loopDetector = createToolCallLoopDetector();
  // Honest idle (Kairos B-1): set once any batch of THIS slice carried a
  // `LoopDefer` call. A later text reply then ends the slice on the run's
  // pending wake instead of earning a continue cue. See
  // `turn-loop-text-response.ts`.
  let loopDeferCalledThisSlice = false;
  // Act, don't narrate (Kairos B-4): a reply that only announced an action
  // earns ONE one-shot turn-state note on the next call, at most once per
  // turn. See `runner/promise-nudge.ts`.
  let promiseNudgeUsed = false;
  let promiseNudgePending = false;
  // Rounds actually entered, so the exhaustion events can report what the turn
  // consumed rather than only which bound fired (rule 05).
  let iterationsUsed = 0;
  const startTime = Date.now();
  let currentTokenCount = tokenCount;
  let currentSummary = summary;

  const liveMessages = [...messages];
  let lastSeenOperatorMessageId = maxOperatorInstructionId(messages);

  // Lease loss (S-1). `leaseLost()` is the runner's claim being gone; it is
  // checked only where the Stop is also checked and always AFTER it, so a Stop
  // is never reported as anything but the Stop.
  const leaseGuard = context.leaseGuard;
  const leaseLost = (): boolean => isLeaseLost(leaseGuard);
  const stopRequested = (): boolean =>
    abortSignal?.aborted === true || inferenceAbortSignal?.aborted === true;
  // The run's Stop, whichever position the caller threaded it in (mission runs
  // pass it in both; chat turns only as the inference signal). Handed to the
  // critical-compaction waits (S-5) - never the lease-lost signal.
  const stopSignal = abortSignal ?? inferenceAbortSignal;
  const turnInferenceSignal = inferenceSignalFor(
    inferenceAbortSignal,
    leaseGuard?.lostSignal,
  );

  // Board presentation scope: staging is possible only while this is open, and
  // closing it discards anything still pending. Opening it here (and closing it
  // at every exit below) is the whole clearing mechanism for stop, cancel,
  // exhaustion, parking, and a failed turn.
  beginPresentationScope(context.sessionId);

  // Reconcile-before-dispatch after a TAKEOVER: before the first inference
  // (and so before any dispatch), surface the session's unresolved money state
  // to the new runner so nothing in flight under the old runner is repeated.
  // See `turn-loop/takeover-reconcile.ts`. Reads and informs; never replays.
  if (leaseGuard?.tookOverExpiredClaim === true) {
    await reconcileAfterTakeover({
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      leaseGuard,
      liveMessages,
    });
  }

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
    // Runtime measurement: iteration top → just before `executeTurn`.
    const iterationStartMs = performance.now();
    active = await resolveEffectiveInferenceConfig(config, loopConfig.contextLimit, context.sessionId, provider);
    // Lease lost: another runner owns the session. Checked before every other
    // guard of the iteration (the control observer and the iteration counter
    // both write), but never ahead of a Stop, which the entry guards own.
    if (leaseLost() && !stopRequested()) {
      stopReason = "lease_lost";
      break;
    }
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

    iterationsUsed = iteration + 1;
    run.progress.iterationsUsed = iterationsUsed;

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
      // S-5: a Stop ends the critical ladder's bounded wait promptly.
      ...(stopSignal === undefined ? {} : { signal: stopSignal }),
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
    const promptStackStartMs = performance.now();
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
    const promptStackMs = performance.now() - promptStackStartMs;
    postCompactBridgeRemaining = stack.nextPostCompactBridgeRemaining;

    // Stall recovery: the call after an unproductive round carries the note
    // and (guarded) lower effort. Built before the envelope so the ceiling
    // below measures the request that is actually sent.
    // A held-back cut-off answer takes this call for its continuation instead.
    // The two cannot both be pending (the cut-off round was productive and
    // reset the stall streak); the guard only makes that explicit.
    const recoveringFrom = cutoff === null ? stallRecovery.pending() : null;
    const recoveryCall: StallRecoveryCall | null = recoveringFrom === null
      ? null
      : await prepareStallRecoveryCall({
          from: recoveringFrom,
          config: active.config,
          promptOptions: stack.promptOptions,
          liveMessages,
          inLoopPendingApprovals: pendingApprovals.length,
          hasPendingApproval: () => hasPendingForSession(context.sessionId),
        });
    // Cut-off continuation: the fragment rides as the last assistant message
    // and the note in the turn state, for this request only. Effort is the
    // configured one - never lowered for a continuation.
    const callConfig = recoveryCall?.config ?? active.config;
    // A cut-off continuation or a stall recovery takes precedence; neither can
    // follow a promise-only reply in practice (both need a different round).
    const nudgeThisCall = promiseNudgePending && cutoff === null && recoveryCall === null;
    const callPromptOptions = cutoff !== null
      ? { ...stack.promptOptions, cutoffContinuationNote: CUTOFF_CONTINUATION_NOTE }
      : recoveryCall?.promptOptions
        ?? (nudgeThisCall
          ? { ...stack.promptOptions, promiseNudgeNote: PROMISE_NUDGE_NOTE }
          : stack.promptOptions);
    const callMessages = cutoff !== null ? continuationMessages(liveMessages, cutoff) : liveMessages;

    // Build the request envelope ONCE, here, so the ceiling below measures the
    // object that is then sent (see the module header — it is not reproducible).
    // R-7: replays are attached BEFORE the ceiling, so it measures the bytes
    // that are actually sent. Switched off, this is the built envelope itself.
    const replayAttach = reasoningReplay.attach(
      buildTurnEnvelope(context, callMessages, currentSummary, callPromptOptions),
      callConfig.model,
    );
    const envelope = replayAttach.envelope;
    if (replayAttach.attachedMessages > 0) {
      // Counts only; the payload itself is never logged.
      logger.info("engine.turn.reasoning_replay", {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        iteration,
        attachedMessages: replayAttach.attachedMessages,
        attachedBytes: replayAttach.attachedBytes,
      });
    }

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
      config: callConfig,
      contextLimit: active.contextLimit,
      currentTokenCount,
      criticalNoopCounter,
      runnerOwnerId: loopConfig.runnerOwnerId,
      // S-5: a Stop ends the ceiling ladder's bounded wait promptly.
      ...(stopSignal === undefined ? {} : { signal: stopSignal }),
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

    // The recovery is spent only once its request is really issued; a ceiling
    // retry above leaves it armed for the next iteration.
    if (recoveryCall !== null) {
      stallRecovery.consume();
      logger.info("engine.turn.stall_recovery", {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        iteration,
        ...stallRecoveryLogFields(recoveryCall),
      });
    }
    // Spent only once its request is really issued, like the recovery above.
    if (nudgeThisCall) promiseNudgePending = false;
    if (cutoff !== null) {
      // Lengths only, never the answer text.
      logger.info("engine.turn.cutoff_continuation", {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        iteration,
        partialChars: cutoff.content.length,
      });
    }

    // Execute turn (no save yet — deferred save lives in tool-batch helper).
    // `inferenceAbortSignal` (chat-turn only) lets the streaming inference be
    // cancelled mid-response; mission callers leave it undefined.
    const turnResult = await executeTurn(
      context, callMessages, currentSummary, provider, callConfig, stack.tools, callPromptOptions,
      turnInferenceSignal,
      // THE measured object, not a rebuild.
      envelope,
      {
        turnRunId: run.turnRunId,
        iteration,
        preInferenceMs: performance.now() - iterationStartMs,
        promptStackMs,
      },
    );
    // A round a bound stopped before its usage chunk reports zero prompt
    // tokens; it did not shrink the context, so keep the last real reading
    // (`executeTurn` skips the usage row and the session update for the same
    // reason).
    if (turnResult.timedOut === null || turnResult.usageObserved) {
      currentTokenCount = turnResult.promptTokens;
    }
    reasoningReplay.observeRound({
      model: callConfig.model,
      toolCalls: turnResult.toolCalls,
      reasoningReplay: turnResult.reasoningReplay,
      servingProvider: turnResult.servingProvider,
    });
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
    // Inference aborted by the LEASE, not by a Stop: nothing of this stream is
    // persisted (the session belongs to another runner now); the preview is
    // retired with the terminal delta, and the turn ends on `lease_lost`.
    if (turnResult.inferenceAborted && !stopRequested() && leaseLost()) {
      streamDeltaBus.emit(
        toStreamAbortedEvent(
          context.sessionId,
          turnResult.streamId,
          turnResult.nextStreamSequence,
        ),
      );
      cutoff = null;
      stopReason = "lease_lost";
      break;
    }
    if (turnResult.inferenceAborted) {
      if (cutoff !== null) {
        // Stopped mid-continuation: the held-back answer plus whatever the
        // continuation streamed becomes the one `chat_stopped` row. It is
        // never empty (the fragment has text), so its `transcriptAppend`
        // retires the preview like any other persisted stop.
        await saveAssistantMessage(
          context.sessionId,
          stoppedCutoffContent(cutoff, turnResult.content),
          null,
          {
            stopped: true,
            reasoning: stoppedCutoffReasoning(cutoff, turnResult.reasoning),
            ...(leaseGuard === undefined ? {} : { leaseGuard }),
          },
        );
        cutoff = null;
        stopReason = "user_stopped";
        break;
      }
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
          ...(leaseGuard === undefined ? {} : { leaseGuard }),
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
    // A round that completed while the lease was lost: dispatch none of its
    // calls and persist none of its text.
    if (leaseLost()) {
      stopReason = "lease_lost";
      break;
    }

    // ── Stall detection (WP1) and the incomplete-batch rule ─────────
    // Evaluated on the SAME `turnResult` the two dispatch branches below read,
    // and BEFORE either of them, so the classification cannot drift from what
    // the loop actually does with the round.
    //
    // An unproductive round takes neither branch. Before this counter existed
    // a blank round simply ended the iteration body, the `for` continued, and
    // the model was asked the identical question again - silently, with
    // nothing logged and nothing persisted - until `maxIterations` ran out.
    // That is the v0.2.6 report.
    //
    // An INCOMPLETE tool batch (any call dropped as truncated or malformed, or
    // any tool-call round the output limit ended) is refused whole, ALWAYS: none of its calls is dispatched - not even the
    // valid ones, which may include a fund-moving prepare from a plan the model
    // never finished writing - and the assistant tool-call message is not
    // persisted, so the transcript never carries tool calls without results.
    // It then counts as a stall like any other unproductive round.
    //
    // A cut-off continuation round is resolved FIRST and is not classified on
    // its own: whatever it produced, the held-back answer is saved now (see
    // `runner/cutoff-continuation.ts`), so the round counts as productive. The
    // one exception is a continuation that called tools - the fragment is
    // saved on its own row and the round is classified and dispatched below
    // like any other.
    let resolvedAnswer: { content: string; reasoning: string | null } | null = null;
    if (cutoff !== null) {
      const resolution = resolveCutoffContinuation(cutoff, turnResult);
      cutoff = null;
      logger.info("engine.turn.cutoff_continuation_resolved", {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        iteration,
        outcome: resolution.outcome,
        finishReason: turnResult.finishReason,
        savedChars: resolution.content.length,
      });
      if (resolution.kind === "tool_round") {
        await persistTextAnswer({
          context,
          liveMessages,
          content: resolution.content,
          reasoning: resolution.reasoning,
          attachBoard: false,
        });
        lastText = resolution.content;
      } else {
        resolvedAnswer = { content: resolution.content, reasoning: resolution.reasoning };
      }
    }

    const round: InferenceRoundClassification = resolvedAnswer !== null
      ? { kind: "productive" }
      : classifyInferenceRound(turnResult);
    stallRecovery.observe(round);
    if (round.kind === "productive") {
      consecutiveUnproductiveRounds = 0;
    } else {
      consecutiveUnproductiveRounds += 1;
      lastUnproductiveKind = round.kind;
      if (round.kind === "stream_timeout") {
        // A bound stopped the stream. Its partial text is a fragment the model
        // never finished, so nothing is persisted and no `transcriptAppend`
        // will retire the preview: end it here with the terminal delta, the
        // same signal the empty-abort path above sends. Correlated by
        // `streamId`, best-effort like every emission on this bus.
        streamDeltaBus.emit(
          toStreamAbortedEvent(
            context.sessionId,
            turnResult.streamId,
            turnResult.nextStreamSequence,
          ),
        );
        logger.warn("engine.turn.unproductive_round", {
          sessionId: context.sessionId,
          missionRunId: context.missionRunId ?? null,
          iteration,
          classification: round.kind,
          stallKind: round.stall,
          consecutiveUnproductiveRounds,
          limit: MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS,
          // Lengths only, never the text: how much was streamed and dropped.
          droppedContentChars: turnResult.content?.length ?? 0,
          usageObserved: turnResult.usageObserved,
        });
      } else if (round.kind === "incomplete_tool_batch") {
        // Counts, the finish reason and the class only: never argument text.
        logger.warn("engine.turn.incomplete_inference", {
          sessionId: context.sessionId,
          missionRunId: context.missionRunId ?? null,
          iteration,
          classification: round.kind,
          truncated: round.truncated,
          finishReason: turnResult.finishReason,
          validToolCalls: round.validToolCalls,
          malformedToolCalls: round.malformedToolCalls,
          consecutiveUnproductiveRounds,
          limit: MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS,
        });
      } else {
        logger.warn("engine.turn.unproductive_round", {
          sessionId: context.sessionId,
          missionRunId: context.missionRunId ?? null,
          iteration,
          classification: round.kind,
          finishReason: turnResult.finishReason,
          consecutiveUnproductiveRounds,
          limit: MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS,
          // A reasoning-only response is the common shape of this failure and is
          // worth distinguishing in the log: the model spent output tokens, it
          // just never answered.
          reasoningOnly: turnResult.reasoning !== null,
          finalRoundPromptTokens: turnResult.promptTokens,
        });
      }
      // A failed recovery ends the streak at once: the next request would be
      // the original one again, and resending it is the replay recovery
      // exists to prevent.
      if (
        consecutiveUnproductiveRounds >= MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS ||
        stallRecovery.recoveryFailed()
      ) {
        stopReason = "no_progress";
        break;
      }
      continue;
    }

    if (turnResult.toolCalls && turnResult.toolCalls.length > 0) {
      if (turnResult.toolCalls.some((call) => resolveToolName(call.name) === "LoopDefer")) {
        loopDeferCalledThisSlice = true;
      }
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
        // Turn-scoped, so a repetition that starts in one batch is still
        // remembered when the model repeats it in the next one.
        loopDetector,
        // Tags each dispatch timing row with this turn run and round.
        telemetry: { turnRunId: run.turnRunId, iteration },
      });
      totalToolCalls += batchOutcome.toolCallsExecuted;
      run.progress.toolCallsMade = totalToolCalls;
      lastText = batchOutcome.lastText;

      // Lease lost during the batch: the post-batch arms below write run state
      // (wake park, plan park) and merge operator input for a session another
      // runner owns now, so none of them run. Kept: an operator Stop (reported
      // as the Stop) and the parks whose durable state the batch already
      // committed in its own transaction (approval, user form, lighter setup).
      if (
        leaseLost()
        && !(batchOutcome.kind === "engine_stop" && batchOutcome.stopReason === "user_stopped")
        && batchOutcome.kind !== "approval_break"
        && batchOutcome.kind !== "user_form_pause"
        && batchOutcome.kind !== "lighter_setup_pause"
      ) {
        stopReason = "lease_lost";
        break;
      }

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
        // S-5: forwarded into the wake park's critical-compaction wait.
        ...(stopSignal === undefined ? {} : { signal: stopSignal }),
      });
      if (batchStep.kind === "return") {
        // Every one of these exits (approval park, user-form park, wake pause,
        // engine stop) ends the turn without a final prose row, so a staged
        // board has nothing left to attach to.
        endPresentationScope(context.sessionId);
        return batchStep.result;
      }
      continue;
    }

    const answer = resolvedAnswer
      ?? (turnResult.content ? { content: turnResult.content, reasoning: turnResult.reasoning } : null);
    if (answer !== null) {
      // R-9: an answer the output limit cut short is held back, not saved;
      // the next iteration is its one continuation call. Never for the
      // continuation's own result (`resolvedAnswer`), so there is at most one
      // continuation per answer.
      const cutOff = resolvedAnswer === null && CUTOFF_CONTINUATION_ENABLED
        ? detectCutOffAnswer(turnResult)
        : null;
      if (cutOff !== null) {
        cutoff = cutOff;
        continue;
      }
      lastText = answer.content;
      const textOutcome = await handleTextResponse({
        context,
        liveMessages,
        content: answer.content,
        reasoning: answer.reasoning,
        mergeOperatorInstructions,
        loopDeferCalledThisSlice,
      });
      // Act, don't narrate (B-4). Never for a cut-off answer's continuation
      // result, and never on a lease loss or an idle park.
      if (
        resolvedAnswer === null
        && (textOutcome.kind === "mission_run_continue" || textOutcome.kind === "break_on_text")
      ) {
        const nudge = await decidePromiseNudge({
          context,
          content: answer.content,
          liveMessages,
          alreadyNudged: promiseNudgeUsed,
          inLoopPendingApprovals: pendingApprovals.length,
          hasPendingApproval: () => hasPendingForSession(context.sessionId),
        });
        if (nudge.nudge) {
          promiseNudgeUsed = true;
          promiseNudgePending = true;
          // Lengths and enums only, never the reply text.
          logger.info("engine.turn.promise_nudge", {
            sessionId: context.sessionId,
            missionRunId: context.missionRunId ?? null,
            sessionKind: context.sessionKind,
            iteration,
            replyChars: answer.content.length,
          });
          continue;
        }
      }
      if (textOutcome.kind === "mission_run_continue") {
        continue;
      }
      if (textOutcome.kind === "deferred_idle") {
        // Same park a successful `LoopDefer` gets from the batch step: the
        // wake row already exists, so only the run status moves.
        logger.info("engine.mission.idle_defer_parked", {
          sessionId: context.sessionId,
          missionRunId: context.missionRunId ?? null,
          iteration,
        });
        await applyWaitingForWakePostBatch({
          sessionId: context.sessionId,
          missionRunId: context.missionRunId ?? null,
          currentTokenCount,
          contextLimit: active.contextLimit,
          sessionPermission: context.sessionPermission,
          ...(loopConfig.runnerOwnerId === undefined
            ? {}
            : { runnerOwnerId: loopConfig.runnerOwnerId }),
          handlePostCompactBookkeeping,
          ...(stopSignal === undefined ? {} : { signal: stopSignal }),
        });
        endPresentationScope(context.sessionId);
        return {
          text: lastText,
          toolCallsMade: totalToolCalls,
          pendingApprovals,
          stopReason: "waiting_for_wake",
          stopPayload: {
            summary: `Deferred until ${textOutcome.wake.dueAt}`,
            evidence: { dueAt: textOutcome.wake.dueAt, reason: textOutcome.wake.reason },
          },
        };
      }
      if (textOutcome.kind === "lease_lost") {
        stopReason = "lease_lost";
        break;
      }
      stoppedOnText = true;
      break;
    }
  }

  // A cut-off answer still held back means the loop ended before its
  // continuation was issued (a stop, a deadline, the iteration bound, a
  // refused request). It is still the turn's answer: save it, marked as
  // incomplete, with any staged board - before the scope below discards it.
  if (cutoff !== null && stopReason !== "lease_lost") {
    const content = cutoff.content + CUTOFF_ANSWER_SUFFIX;
    await persistTextAnswer({
      context,
      liveMessages,
      content,
      reasoning: cutoff.reasoning,
      attachBoard: true,
    });
    lastText = content;
    logger.info("engine.turn.cutoff_continuation_resolved", {
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      outcome: "not_issued",
      stopReason,
      savedChars: content.length,
    });
    cutoff = null;
  }

  // Close the board scope for every remaining exit: a stop, a cancellation, a
  // deadline, a stalled run, iteration exhaustion, and the clean text break
  // (whose board was already consumed by the row that committed it). A throw
  // out of the loop leaves the scope open until the session's next
  // `beginPresentationScope`, which discards it before anything can read it.
  endPresentationScope(context.sessionId);

  // If the for-loop exhausted maxIterations without either an explicit stop OR
  // a natural text-break (agent/setup), surface it as `iteration_limit` so every
  // transport can see why.
  if (!stopReason && !stoppedOnText) {
    stopReason = "iteration_limit";
  }

  // The distinct lease-loss record for the TURN (the guard logged the moment
  // of detection). Counts and ids only.
  if (stopReason === "lease_lost") {
    logger.warn("runtime.lease.lost", {
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      stage: "turn_ended",
      reason: leaseGuard?.lostReason() ?? null,
      iterationsUsed,
      toolCallsMade: totalToolCalls,
    });
  }

  // Rule 05: the owner of a bound REPORTS what was consumed when it fires.
  // Neither of these had any structured record before - the user was told "I
  // reached my budget" with no way to learn the budget was 50, or that all 50
  // rounds produced nothing. Modelled on `engine.mission.deadline_enforced`
  // above, which is the same shape for the same class of bound.
  if (stopReason === "iteration_limit" || stopReason === "no_progress") {
    logger.warn(
      stopReason === "no_progress"
        ? "engine.turn.no_progress_stop"
        : "engine.turn.iteration_limit_stop",
      {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId ?? null,
        stopReason,
        iterationsUsed,
        maxIterations: loopConfig.maxIterations,
        consecutiveUnproductiveRounds,
        unproductiveRoundLimit: MAX_CONSECUTIVE_UNPRODUCTIVE_ROUNDS,
        lastUnproductiveKind,
        toolCallsMade: totalToolCalls,
        producedText: lastText !== null,
        elapsedMs: Date.now() - startTime,
      },
    );
  }

  return {
    text: lastText,
    toolCallsMade: totalToolCalls,
    pendingApprovals,
    stopReason,
    ...(stopReason === "no_progress" && lastUnproductiveKind !== null ? { lastUnproductiveKind } : {}),
  };
}
