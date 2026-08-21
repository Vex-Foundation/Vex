/**
 * Engine runner — agent turn entry point.
 *
 * "Agent" is the one-shot conversational session kind (post-M12 rename
 * from "chat"). The model may emit tool calls, dispatch transactions
 * subject to session permission, and respond with text. No loop — when
 * a final text reply lands the turn ends. Wake / `LoopDefer` are
 * mission-mode only.
 */

import type { ResumedTurnClaim, TurnResult } from "../../types.js";
import type {
  InferenceConfig,
  InferenceProvider,
  ReasoningEffort,
} from "@vex-agent/inference/types.js";
import { hydrateEngineSession } from "../hydrate.js";
import type { TurnLoopConfig } from "../turn-loop.js";
import { runTurnLoop } from "../turn-loop.js";
import { getOpenAITools, type ToolVisibilityBase } from "@vex-agent/tools/registry.js";
import { computeBand } from "../context-band.js";
import { resolveProvider } from "@vex-agent/inference/registry.js";
import { appendMessage } from "@vex-agent/engine/events/index.js";
import logger from "@utils/logger.js";
import { releaseLeaseAndEmitControlState } from "../../runtime/release-and-emit.js";
import { toToolDefinitions, DEFAULT_LOOP_CONFIG, runtimeBoundExhaustedReply } from "./shared.js";
import { maxIterationsForPermission } from "./iteration-budget.js";
import {
  cancelForegroundStoppedSessionWake,
  isContinuableRuntimeStop,
  scheduleAgentSessionContinuation,
} from "./runtime-continuation.js";
import {
  registerSessionSliceAbortController,
  unregisterSessionSliceAbortController,
} from "../../runtime/session-slice-abort.js";

// ── processAgentTurn ────────────────────────────────────────────

/**
 * Per-turn request options threaded from the desktop host (S6/D6). Optional
 * and additive: existing call sites compile unchanged. Only interactive
 * agent turns honour these — mission setup/resume/wake keep the engine
 * defaults (no reasoning param unless explicitly requested, no
 * per-iteration UI).
 */
export interface TurnRequestOptions {
  /**
   * Operator-chosen reasoning effort for THIS turn. Applied to the
   * caller-owned `InferenceConfig` copy; `buildOpenRouterParams` only sends
   * it when the model advertises reasoning support
   * (`config.supportsReasoningEffort`), so a stale/unsupported request can
   * never change a non-advertising model's request shape or cost.
   */
  readonly reasoningEffort?: ReasoningEffort;
}

/**
 * Process a single agent turn. User sends message → engine responds.
 * For sessionKind="agent", the turn-loop iterates tool-call rounds
 * until the model emits a final text reply (capped by maxIterations).
 */
export async function processAgentTurn(
  sessionId: string,
  userInput: string,
  signal?: AbortSignal,
  options?: TurnRequestOptions,
): Promise<TurnResult> {
  logger.info("engine.agent.turn", { sessionId });

  const provider = await resolveProvider();
  if (!provider) throw new Error("No inference provider available");

  const config = await provider.loadConfig();
  if (!config) throw new Error("No inference config available");

  // Stamp the per-turn reasoning effort on OUR config copy (loadConfig hands
  // out caller-owned clones, never the cached reference). The support gate
  // lives in buildOpenRouterParams — single source of truth.
  if (options?.reasoningEffort !== undefined) {
    config.reasoningEffort = options.reasoningEffort;
  }

  // Puzzle 03 — claim the session lease BEFORE the first state
  // mutation (codex blocker #2): two rapid `chat.submit` IPC calls
  // on the same session must not both append user messages + fork
  // the turn loop.
  const ownerId = `agent-turn-${Math.random().toString(36).slice(2, 12)}`;
  const { claimSessionLease } = await import("../../runtime/lease-and-status.js");
  const claim = await claimSessionLease({
    sessionId,
    ownerId,
    processKind: "electron_main",
    ttlMs: 5 * 60_000,
  });
  if (claim.outcome === "lease_busy") {
    throw new Error(
      `Session ${sessionId} runner lease busy — another agent turn is in progress.`,
    );
  }
  const { createLeaseHandle } = await import("../../runtime/lease-handle.js");
  const sessionLease = createLeaseHandle({
    lease: claim.lease,
    ownerId,
    ttlMs: 5 * 60_000,
  });

  try {
    // Save user message (FIRST state mutation, under lease)
    await appendMessage(
      sessionId,
      { role: "user", content: userInput, timestamp: new Date().toISOString() },
      { source: "user", messageType: "chat", visibility: "user" },
    );

    return await runAgentTurnUnderLease(
      sessionId,
      provider,
      config,
      signal,
      undefined,
      undefined,
      // This function claimed the lease above — it can prove ownership.
      ownerId,
    );
  } finally {
    // COMMITTED-WAKE CLEANUP. A foreground Stop is request-local by contract,
    // but the turn it stopped may already have COMMITTED a session-scoped park
    // (`LoopDefer`). Cancelling it here is what makes the foreground Stop mean
    // "the agent stops", instead of "this response stops and the agent wakes up
    // again in thirty seconds". Best-effort: a failure here must never mask the
    // turn's own outcome, and the durable Stop path remains available.
    if (signal?.aborted === true) {
      try {
        const cancelled = await cancelForegroundStoppedSessionWake(sessionId);
        logger.info("engine.agent.foreground_stop_wake_cancelled", {
          sessionId,
          cancelled,
        });
      } catch (cause) {
        logger.warn("engine.agent.foreground_stop_wake_cancel_failed", {
          sessionId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    // The end-of-turn resume hook (A5 attempt 3) fires inside this helper,
    // strictly after the release. See `end-of-turn-resume-hook.ts`.
    await releaseLeaseAndEmitControlState(sessionLease, sessionId);
  }
}

/**
 * Continue a Full-Autonomous AGENT session that the wake executor just claimed.
 *
 * The executor owns the session lease and the wake banner (exactly as it does
 * for a mission run); this function owns only the provider/config resolution
 * the executor must not know about, and then runs an ordinary lease-held turn.
 * There is no user message to append — the transcript already carries the
 * `runtime_yield` marker and the `wake_due` banner explaining why the agent is
 * awake.
 *
 * Permission is immutable per session, so a wake row can only exist for a
 * session that was `full` when the slice was exhausted and still is; the turn
 * below re-reads it from the hydrated context regardless, which is what decides
 * the budget and whether a further continuation is scheduled.
 *
 * ## Cancellation ownership — the half a background slice was missing
 *
 * An interactive turn is stoppable because the IPC caller owns the AbortSignal
 * and passes it in. A wake-driven slice has no request-scoped caller at all, so
 * it previously ran with NO signal: the operator could not stop autonomous work
 * once it was airborne. Two mechanisms close that, and both are needed:
 *
 *   1. A DURABLE pre-slice gate. Before the first token is spent, the queued
 *      operator stop is consumed under the session control lock — the same
 *      lock+gate the park sites use. A session stopped while the wake sat in
 *      the queue never starts a slice at all.
 *   2. A LIVE in-process controller, registered for the session for exactly the
 *      duration of the slice (`session-slice-abort.ts`), mirroring how a
 *      mission run registers its run-scoped controller. Its signal is threaded
 *      into BOTH turn-loop positions — the boundary signal AND the inference
 *      signal — so a Stop lands at the next iteration, inside a tool batch, and
 *      mid-provider-call. `setup-turn.ts` threads both for the same reason.
 *      Never mid-dispatch: a signing or broadcast call in flight still
 *      completes.
 */
export async function continueAgentSessionUnderLease(
  sessionId: string,
  /**
   * The session lease owner id the WAKE EXECUTOR claimed and holds around this
   * whole call. Required, not optional: the slice runs a full turn loop, and
   * without the owner its compaction cutover cannot prove ownership, so
   * Full-Autonomous auto-apply silently never runs during a wake slice.
   */
  runnerOwnerId: string,
): Promise<TurnResult> {
  logger.info("engine.agent.wake_continuation", { sessionId });

  const { gateOnOperatorStopWithClient, withSessionControlLock } = await import(
    "../../runtime/lease-and-status.js"
  );

  /**
   * Run the gate under the session control lock. It both OBSERVES a
   * session-scoped stop and APPLIES it, so calling it is how a stop gets
   * consumed — there is exactly one definition of that, and this is it.
   * Idempotent: a session with nothing queued reports `clear` and writes
   * nothing, so it is safe on more than one exit path.
   */
  const consultStopGate = async (): Promise<boolean> =>
    withSessionControlLock(sessionId, async (client) => {
      const gate = await gateOnOperatorStopWithClient(client, {
        sessionId,
        missionRunId: null,
      });
      return gate.kind === "stopped";
    });

  // (1) REGISTER FIRST — before the gate, before the provider, before anything
  // fallible. The gate and the controller must OVERLAP, not sit end to end:
  // registering afterwards left an interval (gate read → provider load → config
  // load → registration) in which a committed Stop was invisible to both halves
  // — too late for the gate's snapshot, too early to find a controller — and
  // the slice then ran unstoppable. With this ordering a Stop is caught by the
  // gate if it committed before the read, and by the controller if it committed
  // after; there is no third interval.
  const controller = registerSessionSliceAbortController(sessionId);
  try {
    // (2) Durable gate. Fail-closed: a stopped session produces no slice and
    // spends nothing — no provider resolved, no hydrate, no model call.
    if (await consultStopGate()) {
      logger.info("engine.agent.wake_continuation_declined_stopped", { sessionId });
      return {
        text: null,
        toolCallsMade: 0,
        pendingApprovals: [],
        stopReason: "user_stopped",
        missionStatus: null,
      };
    }

    const provider = await resolveProvider();
    if (!provider) throw new Error("No inference provider available");

    const config = await provider.loadConfig();
    if (!config) throw new Error("No inference config available");

    return await runAgentTurnUnderLease(
      sessionId,
      provider,
      config,
      controller.signal,
      undefined,
      // Boundary position too: a background slice must stop at the next
      // iteration, not only mid-stream.
      controller.signal,
      // The executor holds this session's lease for the whole slice, so the
      // turn loop can prove ownership for a compaction cutover.
      runnerOwnerId,
    );
  } finally {
    // (3) CONSUME what stopped us. An applied stop is consumed exactly once —
    // the same rule the run-scoped stop body follows. Without this the row that
    // stopped THIS slice stayed open and the next thing to consult the gate (a
    // fresh user turn, an approved dispatch) was refused by a stop that had
    // already done its job.
    //
    // Conditioned on the signal because that is the only evidence that a stop
    // actually landed on this slice; a healthy slice must not pay for a
    // transaction it does not need. Never masks the slice's own outcome — the
    // caller needs the result (or the original throw) far more than it needs to
    // hear that a cleanup transaction failed, and an unconsumed row degrades to
    // the pre-existing behaviour rather than to anything unsafe.
    if (controller.signal.aborted) {
      try {
        await consultStopGate();
      } catch (cause) {
        logger.warn("engine.agent.wake_continuation_stop_consume_failed", {
          sessionId,
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
    }
    unregisterSessionSliceAbortController(sessionId);
  }
}

/**
 * Run one agent turn with the session lease ALREADY HELD by the caller, and
 * WITHOUT appending a user message.
 *
 * Extracted from `processAgentTurn` so the approval-resume path can re-invoke
 * the agent after an approved tool result lands: that path has no user input to
 * append and holds its own lease, but everything from hydrate onwards must be
 * identical to a normal turn. `processAgentTurn` keeps its exact prior
 * behaviour by claiming the lease, appending the user message, and delegating
 * here.
 *
 * The caller owns the lease lifecycle — this function never claims or releases.
 *
 * `claimTurn` (optional) is the resumed-turn guard: it runs after hydrate and
 * immediately before the model call — the moment this turn actually begins
 * consuming what it was woken for — and a `false` return abandons the turn
 * without calling the model. It only REPORTS whether an earlier attempt already
 * completed this resume; the durable marker is written by the caller after this
 * function returns, so a failure in the model call or the tool batch still
 * leaves the approval recoverable.
 */
export async function runAgentTurnUnderLease(
  sessionId: string,
  provider: InferenceProvider,
  config: InferenceConfig,
  signal?: AbortSignal,
  claimTurn?: ResumedTurnClaim,
  /**
   * Iteration-BOUNDARY cancellation. Interactive turns leave this undefined —
   * `signal` alone (the "stop generating" inference signal) is their contract,
   * and the tool batch already falls back to it. A wake-driven slice passes its
   * session-slice signal here as well, so a Stop also breaks the loop between
   * iterations instead of only mid-stream. Behaviour-preserving for every
   * existing caller.
   */
  boundarySignal?: AbortSignal,
  /**
   * The lease owner id the CALLER holds for this session. Threaded so the turn
   * loop's compaction-apply boundary action can prove ownership by equality
   * against the live lease.
   *
   * Omitted only by callers that hold no lease of their own. That is
   * fail-closed by design: no proven ownership ⇒ the action is not registered
   * and no cutover is consumed. Reading the row's current owner and adopting it
   * would be impersonation, not a check.
   */
  runnerOwnerId?: string,
): Promise<TurnResult> {
  // Hydrate
  const hydrated = await hydrateEngineSession(sessionId);
  if (!hydrated) throw new Error(`Session ${sessionId} not found`);

  // Force agent semantics — even if session has a mission attached, this
  // entry point always processes a single agent turn (no mission loop).
  const agentContext = { ...hydrated.context, sessionKind: "agent" as const };

  const baseVisibility: ToolVisibilityBase = {
    sessionId,
    permission: agentContext.sessionPermission,
    sessionKind: "agent",
    missionRunActive: false,
    planMode: agentContext.planMode ?? false,
  };
  // Seed tools — overridden per turn by buildTurnPromptStack with the live band
  // + `hasSessionMemory`; a fresh agent turn has no narrative chunks yet.
  const tools = toToolDefinitions(getOpenAITools({
    ...baseVisibility,
    contextUsageBand: computeBand(hydrated.tokenCount, config.contextLimit),
    hasSessionMemory: false,
    // Compaction axes are FALSE here by design: this is the runner's
    // pre-loop bootstrap tools array, built before any per-turn preparation
    // read exists. The loop rebuilds the surface every iteration from the
    // real state (`buildTurnPromptStack`), so the conservative answer costs
    // at most one turn without the bypass, while guessing could open it.
    preparationBypassesBarrier: false,
    hasCompactionSummaryReady: false,
  }));

  const loopConfig: TurnLoopConfig = {
    ...DEFAULT_LOOP_CONFIG,
    // Agent iterates through tool-call rounds until the model emits a final
    // text reply; turn-loop.ts breaks on text for sessionKind="agent", so this
    // cap only engages when the model loops on tool-calls without ever
    // summarising. Permission-aware — see `iteration-budget.ts` for why a
    // Full-Autonomous session gets a far larger budget and why the number is
    // not a spend cap. On exhaustion the turn either continues (full autonomy)
    // or synthesises a graceful reply (below), so it is never silent.
    maxIterations: maxIterationsForPermission(agentContext.sessionPermission),
    contextLimit: config.contextLimit,
    baseVisibility,
    // The lease this runner actually holds. Threaded so the compaction-apply
    // boundary action can PROVE ownership (equality against the live lease)
    // rather than adopting whatever owner the row currently names.
    ...(runnerOwnerId === undefined ? {} : { runnerOwnerId }),
  };

  // The transcript (including whatever this turn was woken to observe) is
  // loaded and the next step is the model call — this is "begins consuming".
  // A read-only check: everything fallible on BOTH sides of it leaves the
  // resume recoverable, because nothing durable is written until this function
  // returns to its caller.
  if (claimTurn !== undefined && !(await claimTurn())) {
    return {
      text: null,
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: null,
    };
  }

  const result = await runTurnLoop(
    agentContext,
    hydrated.messages,
    hydrated.summary,
    hydrated.tokenCount,
    provider,
    config,
    tools,
    loopConfig,
    {}, // promptOptions
    boundarySignal, // abortSignal — set only for a wake-driven slice
    signal, // inferenceAbortSignal (9-5a) — chat-turn "stop generating"
  );

  // ── Runtime slice exhausted ────────────────────────────────────
  //
  // BOTH bounds are handled here, not just `iteration_limit`. The old code
  // special-cased the iteration cap alone, so a turn that ran out of wall-clock
  // returned `text: null` and the user got a completely silent turn — the
  // failure this predicate closes.
  //
  // A FULL-AUTONOMY session continues instead of replying: the slice guard is
  // not an outcome, and the owner's contract for autonomous work is that it is
  // not interrupted. The woken turn is a fresh `runTurnLoop`, so the iteration
  // counter and the wall clock both reset.
  //
  // A RESTRICTED session keeps today's one-shot behaviour and gets the
  // deterministic reply, now honest about WHICH bound fired. Only when text is
  // empty — a partial earlier reply is preserved as-is. The turn-loop persists
  // real assistant text itself, so nothing was saved on this path; we persist
  // the synthesised reply as a normal user-visible assistant message.
  let text = result.text;
  if (isContinuableRuntimeStop(result.stopReason)) {
    // The slice's own cancellation signal (a wake-driven slice carries it in
    // both positions). Handed to the scheduler, which re-reads it INSIDE the
    // scheduling transaction rather than pre-sampling it here.
    const sliceSignal = signal ?? boundarySignal;
    const continuation = agentContext.sessionPermission === "full"
      ? await scheduleAgentSessionContinuation({
        sessionId,
        trigger: result.stopReason,
        ...(sliceSignal !== undefined ? { abortSignal: sliceSignal } : {}),
      })
      : { scheduled: false };

    if (!continuation.scheduled && !text) {
      text = runtimeBoundExhaustedReply(result.stopReason);
      await appendMessage(
        sessionId,
        { role: "assistant", content: text, timestamp: new Date().toISOString() },
        { source: "assistant", messageType: "chat", visibility: "user" },
      );
    }
  }

  return {
    text,
    toolCallsMade: result.toolCallsMade,
    pendingApprovals: result.pendingApprovals,
    stopReason: result.stopReason,
    missionStatus: null,
  };
}
