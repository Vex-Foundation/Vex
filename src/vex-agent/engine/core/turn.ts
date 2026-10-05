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
import type {
  InferenceProvider,
  InferenceConfig,
  ParsedToolCall,
  ReasoningReplayPayload,
  ToolDefinition,
} from "@vex-agent/inference/types.js";
import {
  runStreamingInference,
  type InferenceStallKind,
  type StreamingInferenceResult,
} from "@vex-agent/inference/stream-consumer.js";
import {
  createInferenceAttemptTimer,
  settledAttemptOutcome,
  type InferenceAttemptTimer,
} from "@vex-agent/inference/attempt-timing.js";
import { toChatRequestEffort } from "@vex-agent/inference/openrouter/params.js";
import {
  endpointFailoverDepsFrom,
  getSwitchedEndpointTag,
  resolveSessionInferenceConfig,
} from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type { Message } from "@vex-agent/db/repos/messages.js";
import type { BoardSpecV1 } from "../../../lib/board/index.js";
import type { PromptStackOptions } from "../prompts/index.js";
import { buildTurnEnvelope, type TurnEnvelope } from "./turn-envelope.js";
import { timePersist } from "./turn-loop/persist-timing.js";
import {
  appendMessage,
  appendMessagesUnderLease,
  streamDeltaBus,
  toStreamDeltaEvent,
  type FencedAppendEntry,
} from "@vex-agent/engine/events/index.js";
import type { RunnerLeaseGuard } from "../runtime/lease-guard.js";
import * as usageRepo from "@vex-agent/db/repos/usage.js";
import * as sessionsRepo from "@vex-agent/db/repos/sessions.js";
import {
  insertInferenceAttempt,
  recordInBackground,
  type InferenceAttemptRecord,
} from "@vex-agent/db/repos/runtime-timings.js";

import {
  createTextToolCallPreviewGuard,
  guardTextToolCall,
  TEXT_TOOL_CALL_GUARD,
} from "./runner/text-tool-call-guard.js";

/**
 * Runtime-measurement correlation for one inference attempt (Kairos Phase 1).
 * Supplied by the turn loop; its presence is what turns attempt recording on.
 * The two ms fields are measured by the caller, which owns the work they time.
 */
export interface TurnAttemptTelemetry {
  turnRunId: string;
  iteration: number;
  /** Iteration top → just before `executeTurn`. */
  preInferenceMs: number | null;
  /** Time spent in `buildTurnPromptStack` for this iteration. */
  promptStackMs: number | null;
}

export interface SingleTurnResult {
  /** Explicit tool markup was replaced with a notice; no call was parsed or run. */
  textToolCallGuarded?: boolean;
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
   * Provider's terminal reason for this completion (`stop`, `tool_calls`,
   * `length`, …), verbatim; `null` when none was reported. Read by the turn
   * loop's round classification to tell a round cut off by the output limit
   * from a malformed or blank one.
   */
  finishReason: string | null;
  /**
   * Tool calls the provider returned that were dropped as unassemblable
   * (invalid JSON arguments, or no id / name) - see
   * `InferenceResponse.malformedToolCallCount`. Non-zero means `toolCalls` is
   * NOT the batch the model wrote, and the turn loop dispatches none of it.
   */
  malformedToolCallCount: number;
  /**
   * True iff the streaming inference was stopped by `signal` (Stage 9-5a).
   * Captured at stream exit — the turn-loop acts on this, never on the live
   * signal (which could flip after a turn completes).
   */
  inferenceAborted: boolean;
  /**
   * The Kairos stream bound that stopped this inference round (Phase 2B), or
   * `null`. Captured at stream exit like `inferenceAborted`. A timed-out round
   * never carries tool calls (`toolCalls` is null); `content` is whatever
   * text streamed before the bound fired and is NOT a finished answer.
   * Mutually exclusive with `inferenceAborted` (a caller Stop wins).
   */
  timedOut: InferenceStallKind | null;
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
  /**
   * Upstream provider that served this round (routing provenance), or `null`
   * when unreported. Read by the reasoning-replay store (Kairos R-7), which
   * never replays across a provider switch.
   */
  servingProvider?: string | null;
  /**
   * Opaque replayable reasoning for this round's tool calls (Kairos R-7).
   * Present only when replay is switched on for the model's family. Memory
   * only: the turn loop's replay store holds it for the rest of the run; it is
   * never saved with the assistant row.
   */
  reasoningReplay?: ReasoningReplayPayload | null;
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
  telemetry?: TurnAttemptTelemetry,
  options: {
    readonly textToolCallGuard?: boolean;
    /** A held cut-off answer supplies Markdown context for its continuation. */
    readonly textToolCallPresentationPrefix?: string;
  } = {},
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
  const guardEnabled = options.textToolCallGuard ?? TEXT_TOOL_CALL_GUARD;
  const previewGuard = createTextToolCallPreviewGuard(guardEnabled);
  // Attempt timing is observation only: the timer never sees chunk text, and
  // the row is written in the background once the attempt settles, so a
  // completed, aborted or thrown attempt returns or throws exactly as before.
  const timing = telemetry ? createInferenceAttemptTimer() : undefined;
  const attemptStartedAt = new Date();
  let inference: StreamingInferenceResult | undefined;
  let inferenceError: unknown;
  try {
    inference = await runStreamingInference(
      provider,
      envelope.providerMessages,
      tools,
      config,
      {
        signal,
        timing,
        // Sticky provider routing: group every turn of this conversation (or
        // mission run) onto one upstream provider so the prompt cache survives
        // our compaction-driven prefix drift.
        context: {
          sessionId: context.sessionId,
          missionRunId: context.missionRunId,
        },
        onDelta: (chunk, sequence) => {
          lastSequence = sequence;
          if (guardEnabled && chunk.type === "content") {
            const text = previewGuard.push(chunk.text ?? "");
            if (text.length === 0) return;
            chunk = { ...chunk, text };
          }
          streamDeltaBus.emit(
            toStreamDeltaEvent(context.sessionId, streamId, sequence, chunk),
          );
        },
      },
    );
  } catch (err) {
    inferenceError = err;
    throw err;
  } finally {
    if (telemetry && timing) {
      recordAttemptTiming(
        context, config, telemetry, timing, streamId, attemptStartedAt,
        inference, inferenceError, signal,
      );
    }
  }
  const { response, aborted, usageObserved, timedOut } = inference;
  const textGuard = guardTextToolCall(
    response.content,
    (response.toolCalls?.length ?? 0) > 0,
    guardEnabled,
    options.textToolCallPresentationPrefix,
  );
  const previewTail = previewGuard.finish(
    textGuard.guarded || aborted || timedOut !== null || response.malformedToolCallCount > 0,
    response.content,
  );
  if (previewTail.length > 0) {
    lastSequence += 1;
    streamDeltaBus.emit(toStreamDeltaEvent(context.sessionId, streamId, lastSequence, {
      type: "content", text: previewTail,
    }));
  }

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
  //
  // A round stopped by a Kairos stream bound is the same case as an abort: it
  // ended before its usage chunk, so it has no usage to record either.
  if (!((aborted || timedOut !== null) && !usageObserved)) {
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
    content: textGuard.content,
    ...(textGuard.guarded ? { textToolCallGuarded: true } : {}),
    toolCalls: response.toolCalls,
    reasoning: response.reasoning ?? null,
    promptTokens,
    finishReason: response.finishReason ?? null,
    malformedToolCallCount: response.malformedToolCallCount,
    inferenceAborted: aborted,
    timedOut,
    usageObserved,
    streamId,
    nextStreamSequence: lastSequence + 1,
    servingProvider: response.servingProvider ?? null,
    ...(response.reasoningReplay != null && { reasoningReplay: response.reasoningReplay }),
  };
}

/**
 * Record one `inference_attempts` row for an attempt that has just settled.
 *
 * Fire-and-forget and never throws: building the row is guarded, and the
 * write goes through `recordInBackground`. Sanitised fields only - the
 * response contributes counts, ids, names and an emptiness flag, never its
 * text, and an error contributes only `classifyInferenceError`'s label.
 *
 * Outcome and error class come from `settledAttemptOutcome`: a returned
 * round a Kairos bound stopped is a `timeout` with class
 * `KairosStall:<kind>`; a thrown attempt is a `timeout` when the error is a
 * deadline, `aborted` when the caller's own signal fired (a user Stop that
 * surfaced as a rejection rather than a partial), else `error`.
 */
function recordAttemptTiming(
  context: EngineContext,
  config: InferenceConfig,
  telemetry: TurnAttemptTelemetry,
  timing: InferenceAttemptTimer,
  streamId: string,
  startedAt: Date,
  inference: StreamingInferenceResult | undefined,
  error: unknown,
  signal: AbortSignal | undefined,
): void {
  try {
    const snapshot = timing.snapshot();
    const response = inference?.response;
    // Token counts only when the provider reported usage. An attempt stopped
    // before its usage chunk carries a zero-filled placeholder, and recording
    // those zeros would make it look like a zero-token call.
    const usage = inference?.usageObserved === true ? response?.usage : undefined;
    // The effort actually sent - mirrors the gate in `buildOpenRouterParams`
    // (openrouter/params.ts). NULL means the provider's default applied.
    const requestedEffort =
      config.reasoningEffort !== undefined && config.supportsReasoningEffort
        ? toChatRequestEffort(config.reasoningEffort)
        : null;
    const settled = settledAttemptOutcome({ inference, error, signal });
    const row: InferenceAttemptRecord = {
      sessionId: context.sessionId,
      missionRunId: context.missionRunId ?? null,
      turnRunId: telemetry.turnRunId,
      iteration: telemetry.iteration,
      streamId,
      startedAt,
      outcome: settled.outcome,
      errorClass: settled.errorClass,
      model: config.model ?? null,
      // The endpoint the session is on once this attempt settled: a failover
      // switch made during the attempt is adopted in memory before it returns
      // or throws, so this is the endpoint that served (or last failed) it -
      // the same answer `resolveSessionInferenceConfig` gives for pricing,
      // read synchronously so the recorder does no IO.
      endpointTag: getSwitchedEndpointTag(context.sessionId) ?? config.endpointTag ?? null,
      servingProvider: response?.servingProvider ?? null,
      requestedEffort,
      bufferedFallback: snapshot.bufferedFallback,
      fallbackReason: snapshot.fallbackReason,
      capacityRetries: snapshot.capacityRetries,
      capacityRetryClasses: snapshot.capacityRetryClasses,
      preInferenceMs: telemetry.preInferenceMs,
      promptStackMs: telemetry.promptStackMs,
      firstChunkMs: snapshot.firstChunkMs,
      firstReasoningMs: snapshot.firstReasoningMs,
      firstSemanticMs: snapshot.firstSemanticMs,
      reasoningOnlyMs: snapshot.reasoningOnlyMs,
      maxInterChunkGapMs: snapshot.maxInterChunkGapMs,
      totalMs: snapshot.totalMs,
      chunkCount: snapshot.chunkCount,
      finishReason: response?.finishReason ?? null,
      contentEmpty:
        response === undefined ? null : (response.content ?? "").trim().length === 0,
      toolCallCount: snapshot.toolCallCount,
      validToolCallCount: snapshot.validToolCallCount,
      promptTokens: usage?.promptTokens ?? null,
      completionTokens: usage?.completionTokens ?? null,
      reasoningTokens: usage?.reasoningTokens ?? null,
      cachedTokens: usage?.cachedTokens ?? null,
      generationId: response?.generationId ?? null,
    };
    recordInBackground("inference_attempt", () => insertInferenceAttempt(row));
  } catch {
    // Telemetry must never change what the turn returns or throws.
  }
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

/** Options for one assistant row. */
export interface AssistantRowOptions {
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
}

/**
 * Build (without writing) the assistant row `saveAssistantMessage` persists,
 * or `null` when there is nothing to persist. Exposed so the tool-batch
 * persistence can write the assistant row and its tool results in ONE fenced
 * transaction.
 */
export function buildAssistantRow(
  content: string | null,
  toolCalls: ParsedToolCall[] | null,
  opts?: AssistantRowOptions,
): FencedAppendEntry | null {
  const hasContent = content !== null && content !== undefined;
  const calls = toolCalls !== null && toolCalls !== undefined && toolCalls.length > 0
    ? toolCalls
    : null;

  if (!hasContent && calls === null) return null;

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

  return {
    msg: {
      role: "assistant",
      content: content ?? "",
      toolCalls: calls === null
        ? undefined
        : calls.map(tc => ({ id: tc.id, command: tc.name, args: tc.arguments })),
      timestamp: new Date().toISOString(),
    },
    metadata,
  };
}

/**
 * Save an assistant message to DB.
 *
 * Exported for use by turn-loop (deferred save after canonical batch prefix
 * is determined). Accepts ParsedToolCall[] directly - converts to Message format.
 *
 * With `leaseGuard` (a lease-holding runner) the write is FENCED on the claim:
 * after a takeover it writes nothing and returns normally - the loop ends on
 * `lease_lost` at its next check. Without one it writes exactly as before.
 */
export async function saveAssistantMessage(
  sessionId: string,
  content: string | null,
  toolCalls: ParsedToolCall[] | null,
  opts?: AssistantRowOptions & { readonly leaseGuard?: RunnerLeaseGuard },
): Promise<void> {
  const row = buildAssistantRow(content, toolCalls, opts);
  if (row === null) return;
  const guard = opts?.leaseGuard;

  // Timed toward the enclosing turn's `persist_ms`; the write itself is awaited
  // and fails exactly as before.
  if (guard !== undefined) {
    await timePersist(() =>
      appendMessagesUnderLease(sessionId, [row], guard, "assistant_message"));
    return;
  }
  await timePersist(() => appendMessage(sessionId, row.msg, row.metadata));
}
