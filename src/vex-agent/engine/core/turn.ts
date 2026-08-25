/**
 * Single turn — one inference round-trip.
 *
 * Builds prompt stack, consumes provider.chatCompletionStream() (buffered
 * chatCompletion fallback) and accumulates the response, logs usage +
 * updates tokenCount. The assistant message save is deferred to turn-loop.
 *
 * The provider message array (D-LAYOUT cache segments, orphan repair,
 * history-tail marking) is assembled by `turn-envelope.ts`.
 */

import { randomUUID } from "node:crypto";
import type { EngineContext, TurnResult, MessageMetadata } from "../types.js";
import type { InferenceProvider, InferenceConfig, ParsedToolCall, ToolDefinition } from "@vex-agent/inference/types.js";
import { runStreamingInference } from "@vex-agent/inference/stream-consumer.js";
import {
  endpointFailoverDepsFrom,
  resolveSessionInferenceConfig,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { BoardSpecV1 } from "../../../lib/board/index.js";
import type { PromptStackOptions } from "../prompts/index.js";
import { buildTurnEnvelope, type TurnEnvelope } from "./turn-envelope.js";
import {
  appendMessage,
  streamDeltaBus,
  toStreamDeltaEvent,
} from "@vex-agent/engine/events/index.js";
import * as usageRepo from "@vex-agent/db/repos/usage.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";

export interface SingleTurnResult {
  /** Text content from model — null when only tool calls. */
  content: string | null;
  /** Tool calls from model — null when text only. */
  toolCalls: ParsedToolCall[] | null;
  /**
   * Reasoning trace for this turn, when the provider returned one. Populated
   * on BOTH the streaming path and the buffered `chatCompletion` fallback
   * (see `runStreamingInference`). Carried to the deferred assistant save so
   * it lands on the durable row instead of only in the ephemeral preview.
   */
  reasoning: string | null;
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
  /**
   * Identity of the stream this turn previewed, so the CALLER can emit the
   * terminal `aborted` delta correlated to it.
   *
   * The emit deliberately does not live here. Whether an aborted stream ends
   * with a persisted `chat_stopped` assistant row is decided by the turn loop
   * AFTER this function returns, and that decision is exactly what determines
   * whether a terminal delta is wanted: a persisted row brings its own
   * `transcriptAppend`, which has always owned the preview handoff. Emitting
   * at stream exit cleared the preview before that row arrived and reopened
   * the swap gap on the stop-with-partial-content path.
   *
   * `nextStreamSequence` continues the stream's monotonic counter, so a
   * terminal delta orders after every delta the turn emitted.
   */
  streamId: string;
  nextStreamSequence: number;
}

/**
 * Execute a single inference turn.
 *
 * 1. Build the request envelope (`buildTurnEnvelope`: prompt stack, provider
 *    message conversion, orphan repair, cache hints)
 * 2. Consume provider.chatCompletionStream() → accumulate InferenceResponse
 *    (chatCompletion fallback), emitting ephemeral stream deltas on streamDeltaBus
 * 3. Log usage + update tokenCount
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
  prebuiltEnvelope?: TurnEnvelope,
): Promise<SingleTurnResult> {
  // Provider message array (D-LAYOUT segments + orphan repair + history-tail
  // marking) — see `turn-envelope.ts`.
  //
  // `prebuiltEnvelope` is not an optimisation. `buildTurnEnvelope` is NOT
  // reproducible: the turn-state segment embeds `Current time UTC`, so two
  // builds of identical inputs differ. The C8 byte ceiling therefore measures
  // an envelope OBJECT and hands THAT OBJECT here, so the bytes it bounded are
  // the bytes we send. Rebuilding would make the ceiling a statement about a
  // request that was never issued.
  const envelope =
    prebuiltEnvelope ??
    buildTurnEnvelope(context, existingMessages, summary, promptOptions);

  // Inference — consume the streaming path and accumulate a
  // `chatCompletion`-equivalent response, emitting one ephemeral stream delta
  // per provider chunk on `streamDeltaBus`. `runStreamingInference` falls back
  // to buffered `chatCompletion` when the provider cannot stream (see its doc).
  // The stream is a PREVIEW only — the canonical transcript still comes from
  // the deferred save in turn-loop. Emission is best-effort and never throws
  // into the turn (the bus + onDelta both isolate listener errors).
  const streamId = randomUUID();
  // Highest sequence emitted for this stream, so the terminal `aborted` delta
  // continues the same monotonic counter rather than restarting it.
  let lastSequence = -1;
  const { response, aborted, usageObserved } = await runStreamingInference(
    provider,
    envelope.providerMessages,
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
        lastSequence = sequence;
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
    // Cost is priced against the endpoint that ACTUALLY served this turn, not
    // the one we set out to use. The failover can switch endpoints mid-send, and
    // sibling endpoints of one model differ in price, so pricing the response
    // against the pre-send config would record a knowingly wrong number
    // (owner decision 7; `rules/90` forbids shipping a false money figure).
    // Only the LOCAL price table is affected — the provider's own `usage.cost`
    // stays authoritative wherever it reported one. In-memory after the first
    // read, so this costs nothing on the common path.
    const pricingConfig = await resolveSessionInferenceConfig(
      config,
      context.sessionId,
      endpointFailoverDepsFrom(provider),
    );
    const cost = provider.calculateCost(response.usage, pricingConfig);
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
      // Provider provenance (migration 055). `generationId` is the only key
      // that reconciles this row against OpenRouter's own activity log;
      // `finishReason` makes a truncated completion (`length`) distinguishable
      // from a complete one after the fact. Both already bounded at the
      // inference boundary; `?? null` covers a provider that reported neither
      // and an abort that ended the turn before they arrived.
      generationId: response.generationId ?? null,
      finishReason: response.finishReason ?? null,
      // Endpoint-level provenance (migration 059). `provider` above is the
      // AGGREGATOR ('openrouter'); this is the upstream that actually ran the
      // model, so "which request went where" — unanswerable during the
      // 2026-07-29 endpoint-level 429 — is now a query.
      servingProvider: response.servingProvider ?? null,
    });
    await sessionsRepo.updateTokenCount(context.sessionId, promptTokens);
  }

  return {
    content: response.content,
    toolCalls: response.toolCalls,
    reasoning: response.reasoning ?? null,
    promptTokens,
    inferenceAborted: aborted,
    usageObserved,
    streamId,
    nextStreamSequence: lastSequence + 1,
  };
}

/**
 * Maximum reasoning characters persisted on an assistant row.
 *
 * MUST stay in lockstep with the renderer's `REASONING_TEXT_CAP` and with the
 * `sessionMessageDtoSchema` bound (C1) — a longer write would fail DTO
 * validation and drop the whole page.
 */
export const REASONING_PAYLOAD_CAP = 16_384;

/**
 * Cap the reasoning trace, KEEPING THE TAIL. The end of a reasoning trace is
 * where the model states its conclusion, so an over-long trace loses its
 * opening, never its ending. Whitespace-only traces are dropped entirely so
 * the JSONB column carries no empty-string noise.
 */
function reasoningForPayload(reasoning: string | null | undefined): string | null {
  if (reasoning === null || reasoning === undefined) return null;
  if (reasoning.trim().length === 0) return null;
  return reasoning.slice(-REASONING_PAYLOAD_CAP);
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
  opts?: {
    readonly stopped?: boolean;
    readonly systemOriginated?: boolean;
    /** Provider reasoning trace for this turn; capped + tail-kept on persist. */
    readonly reasoning?: string | null;
    /**
     * A board staged by `BoardCompose` earlier in THIS turn, consumed by the
     * row being written here. Runtime-authored: it is the validated, hydrated
     * spec the engine built, never model output re-read from anywhere.
     *
     * Passing it is what makes prose and board ONE commit. Only
     * `handleTextResponse` sets it, and only after taking the board out of the
     * session's pending slot; every other caller omits it.
     */
    readonly board?: BoardSpecV1;
  },
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

  // `payload` is the ONLY part of MessageMetadata that reaches the
  // `messages.metadata` JSONB column (db/repos/messages/write.ts), so the
  // reasoning trace rides there — the desktop app reads it as the column's
  // top-level `metadata -> 'reasoning'`. Omitted entirely when there is none.
  // `board` rides the same payload and surfaces as `metadata -> 'board'`, which
  // is the column the desktop app projects the board block from. Omitted
  // entirely when no board was staged, so ordinary rows carry no extra JSONB.
  const reasoning = reasoningForPayload(opts?.reasoning);
  if (reasoning !== null || opts?.board !== undefined) {
    metadata.payload = {
      ...(reasoning !== null ? { reasoning } : {}),
      ...(opts?.board !== undefined ? { board: opts.board } : {}),
    };
  }

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
