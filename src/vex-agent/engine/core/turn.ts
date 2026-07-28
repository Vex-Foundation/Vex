/**
 * Single turn — one inference round-trip.
 *
 * Builds prompt stack, consumes provider.chatCompletionStream() (buffered
 * chatCompletion fallback) and accumulates the response, logs usage +
 * updates tokenCount. The assistant message save is deferred to turn-loop.
 *
 * Provider-message layout (D-LAYOUT) — four cache segments, marked with
 * `cacheHint` so the inference layer can place cache breakpoints without
 * positional heuristics:
 *
 *   [0]  system  static prefix (joined staticLayers)   "static_prefix"
 *   [1]  system  compaction summary (when present)     "summary"
 *   […]  history (DB tape; LAST non-empty message      "history_tail"
 *        marked AFTER repairOrphanedToolCalls)
 *   [N]  system  turn state (joined turnLayers)        "turn_state"
 */

import { randomUUID } from "node:crypto";
import type { EngineContext, TurnResult, MessageMetadata } from "../types.js";
import type { InferenceProvider, InferenceConfig, ProviderMessage, ParsedToolCall, ToolDefinition } from "@vex-agent/inference/types.js";
import { runStreamingInference } from "@vex-agent/inference/stream-consumer.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import { buildPromptStack, type PromptStackOptions } from "../prompts/index.js";
import { sanitizeForSystemPrompt } from "../prompts/sanitize.js";
import { repairOrphanedToolCalls } from "./transcript-integrity.js";
import { appendMessage, streamDeltaBus, toStreamDeltaEvent } from "@vex-agent/engine/events/index.js";
import * as usageRepo from "@vex-agent/db/repos/usage.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import logger from "@utils/logger.js";

export interface SingleTurnResult {
  /** Text content from model — null when only tool calls. */
  content: string | null;
  /** Tool calls from model — null when text only. */
  toolCalls: ParsedToolCall[] | null;
  /** Token usage from this request. */
  promptTokens: number;
  /**
   * True iff the streaming inference was stopped by `signal` (Stage 9-5a).
   * Captured at stream exit — the turn-loop acts on this, never on the live
   * signal (which could flip after a turn completes).
   */
  inferenceAborted: boolean;
  /** True iff a provider usage chunk was observed before the stream exited. */
  usageObserved: boolean;
}

/**
 * Execute a single inference turn.
 *
 * 1. Build prompt stack (static + turn-state segments)
 * 2. Convert messages to provider format (4 cache segments, hints set here)
 * 3. Consume provider.chatCompletionStream() → accumulate InferenceResponse
 *    (chatCompletion fallback), emitting ephemeral stream deltas on streamDeltaBus
 * 4. Log usage + update tokenCount
 *
 * `promptOptions` arrives FULLY BUILT from the caller — `buildTurnPromptStack`
 * owns the single pre-inference memory read (`memory.getTurnContext`) and the
 * rendered `memorySection`; this function performs no memory/knowledge IO.
 *
 * NOTE: Does NOT save the assistant message. The caller (turn-loop)
 * handles deferred save after determining the canonical batch prefix
 * (trimming tool calls that were never dispatched due to approval/signal breaks).
 * Use saveAssistantMessage() for the actual persist.
 */
export async function executeTurn(
  context: EngineContext,
  existingMessages: Message[],
  summary: string | null,
  provider: InferenceProvider,
  config: InferenceConfig,
  tools: ToolDefinition[],
  promptOptions: PromptStackOptions = {},
  signal?: AbortSignal,
): Promise<SingleTurnResult> {
  // Build prompt — split into the stable static prefix and the volatile
  // turn-state segment (D-LAYOUT). Each segment is joined separately.
  const promptStack = buildPromptStack(context, promptOptions);
  const staticPrompt = promptStack.staticLayers.join("\n\n---\n\n");
  const turnStatePrompt = promptStack.turnLayers.join("\n\n---\n\n");

  // Convert to provider format
  const providerMessages = buildProviderMessages(
    staticPrompt,
    summary,
    existingMessages,
    turnStatePrompt,
  );

  // In-flight repair only; DB tape remains unchanged.
  const repair = repairOrphanedToolCalls(providerMessages);
  if (repair.insertedPlaceholders > 0) {
    logger.info("turn.transcript.repaired", {
      sessionId: context.sessionId,
      inserted: repair.insertedPlaceholders,
    });
  }

  // Mark the history tail AFTER repair so breakpoint B sits on the FINAL
  // tape — repair may append placeholder tool rows behind an assistant with
  // unanswered tool calls, and B must not land before them. `hasSummary`
  // mirrors buildProviderMessages' truthiness check (empty string = none).
  markHistoryTail(repair.messages, summary !== null && summary.length > 0);

  // Inference — consume the streaming path and accumulate a
  // `chatCompletion`-equivalent response, emitting one ephemeral stream delta
  // per provider chunk on `streamDeltaBus`. `runStreamingInference` falls back
  // to buffered `chatCompletion` when the provider cannot stream (see its doc).
  // The stream is a PREVIEW only — the canonical transcript still comes from
  // the deferred save in turn-loop. Emission is best-effort and never throws
  // into the turn (the bus + onDelta both isolate listener errors).
  const streamId = randomUUID();
  const { response, aborted, usageObserved } = await runStreamingInference(
    provider,
    repair.messages,
    tools,
    config,
    {
      signal,
      // Sticky provider routing: group every turn of this conversation (or
      // mission run) onto one upstream provider so the prompt cache survives
      // our compaction-driven prefix drift.
      context: {
        sessionId: context.sessionId,
        missionRunId: context.missionRunId,
      },
      onDelta: (chunk, sequence) => {
        streamDeltaBus.emit(
          toStreamDeltaEvent(context.sessionId, streamId, sequence, chunk),
        );
      },
    },
  );

  // Log usage + update token count
  // NOTE: assistant message is NOT saved here — turn-loop handles deferred save
  // after determining the canonical batch prefix (trimming unexecuted tool calls).
  const promptTokens = response.usage.promptTokens ?? 0;
  const completionTokens = response.usage.completionTokens ?? 0;

  // Skip usage logging + token_count update ONLY when the stream was aborted
  // before any usage chunk arrived — otherwise a zero usage row would be written
  // and sessions.token_count reset to 0, wrecking context-pressure tracking
  // (Stage 9-5a). A normal turn, or an abort that already saw usage, records it.
  //
  // token_count = SET, not accumulate. Stores the latest prompt size (total tokens
  // sent to provider including system prompt + messages). Used by checkpoint to
  // evaluate context window pressure: shouldCheckpoint(tokenCount, contextLimit).
  if (!(aborted && !usageObserved)) {
    const cost = provider.calculateCost(response.usage, config);
    await usageRepo.logUsage(context.sessionId, {
      promptTokens,
      completionTokens,
      cachedTokens: response.usage.cachedTokens ?? 0,
      reasoningTokens: response.usage.reasoningTokens ?? 0,
      cost: cost.totalCost,
      provider: config.provider,
      model: config.model,
      currency: cost.currency,
      // NET cache savings (read − write surcharge; negative possible) +
      // cache-write tokens — persisted at log time (D-SAVINGS).
      cachedSavings: cost.breakdown.cachedSavings,
      cacheWriteTokens: response.usage.cacheWriteTokens ?? 0,
    });
    await sessionsRepo.updateTokenCount(context.sessionId, promptTokens);
  }

  return {
    content: response.content,
    toolCalls: response.toolCalls,
    promptTokens,
    inferenceAborted: aborted,
    usageObserved,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

function buildProviderMessages(
  staticPrompt: string,
  summary: string | null,
  messages: Message[],
  turnStatePrompt: string,
): ProviderMessage[] {
  const result: ProviderMessage[] = [];

  // Static system prefix — breakpoint A candidate.
  result.push({ role: "system", content: staticPrompt, cacheHint: "static_prefix" });

  // Compaction summary (if checkpoint happened). The summary is the agent's
  // own `compact_now.conversation_summary` argument — LLM-emitted prose that
  // reaches the next provider call as a system message. Sanitize before
  // injection so a crafted summary can't carry fence escapes or pseudo role
  // tags into the durable rolling context.
  if (summary) {
    result.push({
      role: "system",
      content: `[Previous conversation summary]\n${sanitizeForSystemPrompt(summary)}`,
      cacheHint: "summary",
    });
  }

  // Message history
  for (const msg of messages) {
    const providerMsg: ProviderMessage = {
      role: msg.role as ProviderMessage["role"],
      content: msg.content,
    };

    if (msg.toolCallId) {
      providerMsg.toolCallId = msg.toolCallId;
    }

    if (msg.toolCalls) {
      providerMsg.toolCalls = msg.toolCalls.map(tc => ({
        id: tc.id,
        command: tc.command,
        args: tc.args,
      }));
    }

    result.push(providerMsg);
  }

  // Trailing turn-state system message — NEVER cache-marked for a breakpoint.
  result.push({ role: "system", content: turnStatePrompt, cacheHint: "turn_state" });

  return result;
}

/**
 * Mark the LAST history message with non-empty content as `history_tail`
 * (breakpoint B carrier). Empty-content rows are skipped backwards; an empty
 * history leaves no marker (no B). Role-agnostic — production tapes
 * legitimately end with system rows (continue-cue / operator-cue) or with
 * repair-inserted placeholder tool rows, which carry non-empty content.
 *
 * Operates on the POST-repair tape: history spans the indices between the
 * leading static/summary system messages and the trailing turn-state message.
 */
function markHistoryTail(messages: ProviderMessage[], hasSummary: boolean): void {
  const historyStart = hasSummary ? 2 : 1;
  // Last index before the trailing turn-state message.
  for (let i = messages.length - 2; i >= historyStart; i--) {
    if (messages[i].content.length > 0) {
      messages[i].cacheHint = "history_tail";
      return;
    }
  }
}

/**
 * Save an assistant message to DB.
 *
 * Exported for use by turn-loop (deferred save after canonical batch prefix
 * is determined). Accepts ParsedToolCall[] directly — converts to Message format.
 */
export async function saveAssistantMessage(
  sessionId: string,
  content: string | null,
  toolCalls: ParsedToolCall[] | null,
  opts?: { readonly stopped?: boolean; readonly systemOriginated?: boolean },
): Promise<void> {
  const hasContent = content !== null && content !== undefined;
  const hasToolCalls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0;

  if (!hasContent && !hasToolCalls) return;

  const metadata: MessageMetadata = {
    // `role` stays "assistant" even for a system-synthesized call (below) —
    // the provider transcript format requires an assistant-role turn to
    // carry `tool_calls`. Provenance instead lives here: a genuinely
    // model-authored turn always stamps `source: "assistant"`; a call the
    // engine synthesized itself (never model output — see
    // `dispatchPreparedActionFollowUp`) stamps `source: "engine"` with a
    // distinct `messageType` so an auditor reading `messages` directly can
    // never mistake one for the other, regardless of the shared `role`.
    source: opts?.systemOriginated === true ? "engine" : "assistant",
    // 9-5a: a chat turn stopped mid-stream persists its partial text as
    // `chat_stopped`, so the ephemeral streamed preview is replaced by a
    // durable row. Renderer mapping/badge for this type lands in 9-5b.
    messageType:
      opts?.stopped === true
        ? "chat_stopped"
        : opts?.systemOriginated === true
          ? "prepared_action_follow_up"
          : "chat",
    visibility: "user",
  };

  await appendMessage(
    sessionId,
    {
      role: "assistant",
      content: content ?? "",
      toolCalls: hasToolCalls
        ? toolCalls!.map(tc => ({ id: tc.id, command: tc.name, args: tc.arguments }))
        : undefined,
      timestamp: new Date().toISOString(),
    },
    metadata,
  );
}
