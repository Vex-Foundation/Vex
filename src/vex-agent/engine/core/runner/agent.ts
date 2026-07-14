/**
 * Engine runner — agent turn entry point.
 *
 * "Agent" is the one-shot conversational session kind (post-M12 rename
 * from "chat"). The model may emit tool calls, dispatch transactions
 * subject to session permission, and respond with text. No loop — when
 * a final text reply lands the turn ends. Wake / `loop_defer` are
 * mission-mode only.
 */

import type { TurnResult } from "../../types.js";
import type { ReasoningEffort } from "@vex-agent/inference/types.js";
import { hydrateEngineSession } from "../hydrate.js";
import type { TurnLoopConfig } from "../turn-loop.js";
import { runTurnLoop } from "../turn-loop.js";
import { getOpenAITools, type ToolVisibilityBase } from "@vex-agent/tools/registry.js";
import { computeBand } from "../context-band.js";
import { resolveProvider } from "@vex-agent/inference/registry.js";
import { appendMessage } from "@vex-agent/engine/events/index.js";
import logger from "@utils/logger.js";
import { toToolDefinitions, DEFAULT_LOOP_CONFIG, ITERATION_LIMIT_REPLY } from "./shared.js";
import { buildPersonaSetupHint } from "@vex-agent/engine/prompts/persona-setup.js";

// ── processAgentTurn ────────────────────────────────────────────

/**
 * Per-turn request options threaded from the desktop host (S6). Optional and
 * additive: existing call sites compile unchanged. Only interactive agent
 * turns honour these — mission setup/resume/wake keep the engine defaults
 * (uniform "medium"-when-supported reasoning, no per-iteration UI).
 */
export interface TurnRequestOptions {
  /**
   * Operator-chosen reasoning effort for THIS turn. Applied to the
   * caller-owned `InferenceConfig` copy; `buildOpenRouterParams` only acts
   * on it when the model supports reasoning (`reasoningPricePerM !== null`),
   * so a stale/unsupported request can never change a non-reasoning model's
   * request shape or cost.
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

  // Hydrate
  const hydrated = await hydrateEngineSession(sessionId);
  if (!hydrated) throw new Error(`Session ${sessionId} not found`);

  // Force agent semantics — even if session has a mission attached, this
  // entry point always processes a single agent turn (no mission loop).
  const agentContext = { ...hydrated.context, sessionKind: "agent" as const };

  // One-time persona-setup offer: only when the persona is unconfigured AND
  // this is the session's first reply (no prior assistant turn). Transcript-
  // gated so it never repeats once the agent has spoken or a persona is set.
  const personaSetupHint =
    !agentContext.personaConfigured
    && !hydrated.messages.some(m => m.role === "assistant")
      ? buildPersonaSetupHint(agentContext.personaName)
      : undefined;

  const baseVisibility: ToolVisibilityBase = {
    sessionId,
    permission: agentContext.sessionPermission,
    role: "parent",
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
  }));

  const loopConfig: TurnLoopConfig = {
    ...DEFAULT_LOOP_CONFIG,
    // Agent iterates through tool-call rounds until the model emits a final
    // text reply; turn-loop.ts breaks on text for sessionKind="agent", so this
    // cap only engages when the model loops on tool-calls without ever
    // summarising. Raised 10 -> 50 so a heavy multi-source task (research +
    // execution + verify) is not cut off mid-work; on cap-hit we still
    // synthesise a graceful reply (below) so the turn is never silent.
    maxIterations: 50,
    contextLimit: config.contextLimit,
    baseVisibility,
  };

  const result = await runTurnLoop(
    agentContext,
    hydrated.messages,
    hydrated.summary,
    hydrated.tokenCount,
    provider,
    config,
    tools,
    loopConfig,
    { personaSetupHint }, // promptOptions
    undefined, // abortSignal — chat turns have no mission-boundary controller
    signal, // inferenceAbortSignal (9-5a) — chat-turn "stop generating"
  );

    // Graceful cap-hit reply: when the loop exhausted maxIterations WITHOUT the
    // model ever emitting text (`text` is null/empty), persist a deterministic
    // assistant message so the user never sees a silent empty turn. Only when
    // text is empty — a partial earlier reply (lastText) is preserved as-is.
    // The turn-loop persists real assistant text itself, so nothing was saved
    // on this path; we persist the synthesised reply here as a normal
    // user-visible assistant message (same metadata saveAssistantMessage uses).
    let text = result.text;
    if (result.stopReason === "iteration_limit" && !text) {
      text = ITERATION_LIMIT_REPLY;
      await appendMessage(
        sessionId,
        { role: "assistant", content: text, timestamp: new Date().toISOString() },
        { source: "assistant", messageType: "chat", visibility: "user" },
      );
    }

    return {
      text,
      toolCallsMade: result.toolCallsMade,
      pendingApprovals: result.pendingApprovals,
      stopReason: result.stopReason,
      missionStatus: null,
    };
  } finally {
    const { releaseLeaseAndEmitControlState } = await import(
      "../../runtime/release-and-emit.js"
    );
    await releaseLeaseAndEmitControlState(sessionLease, sessionId);
  }
}
