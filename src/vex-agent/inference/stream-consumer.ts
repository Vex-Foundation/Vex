/**
 * Stream consumer (Stage 9-1, abort-aware in 9-5a) — provider-agnostic.
 *
 * Consumes an `InferenceProvider.chatCompletionStream` async generator,
 * accumulating the SAME `InferenceResponse` that `chatCompletion` would
 * return (behaviour-equivalent with `parseNonStreamingResponse`), while
 * invoking `onDelta(chunk, sequence)` once per provider chunk so callers can
 * mirror the stream onto the engine `streamDeltaBus`.
 *
 * Assembly happens on GENERATOR EXHAUSTION (or abort break), not on the `done`
 * chunk — `done` is informational, so trailing chunks (e.g. a usage chunk
 * emitted after the finish reason) and repeated `done` chunks are never lost.
 *
 * Returns explicit facts captured AT stream exit — `aborted` and
 * `usageObserved` — so the caller never has to re-inspect the live signal
 * (which could flip AFTER a turn completes and misclassify it; Stage 9-5a).
 *
 * Cancellation (9-5a): when `options.signal` aborts, the loop breaks (or the
 * SDK throws), we set `aborted = true`, and return the PARTIAL response. Abort
 * is NEVER a fallback: a pre-aborted signal short-circuits before every
 * `chatCompletion` fallback branch. Distinct from a provider error (rethrown)
 * and a setup failure before any chunk (buffered fallback).
 */

import type {
  InferenceConfig,
  InferenceProvider,
  InferenceRequestContext,
  InferenceResponse,
  InferenceUsage,
  ParsedToolCall,
  ProviderMessage,
  StreamChunk,
  ToolDefinition,
} from "./types.js";
import logger from "@utils/logger.js";
import { attachErrorType, attachStatus, scrubMessage } from "./openrouter/errors.js";
import { assertActionableInferenceResponse } from "./response-validation.js";

const ZERO_USAGE: InferenceUsage = {
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
};

/** Result of one streaming inference, with facts captured at stream exit. */
export interface StreamingInferenceResult {
  readonly response: InferenceResponse;
  /** True iff the stream was stopped because `options.signal` aborted. */
  readonly aborted: boolean;
  /** True iff a provider `usage` chunk was consumed before exit. */
  readonly usageObserved: boolean;
}

export interface RunStreamingInferenceOptions {
  /** Invoked once per provider chunk, in order, with a monotonic sequence. */
  readonly onDelta?: (chunk: StreamChunk, sequence: number) => void;
  /** Aborts the in-flight inference stream (chat-turn "stop generating"). */
  readonly signal?: AbortSignal;
  /**
   * Groups this request for sticky provider routing. Passed to BOTH the
   * streaming attempt and the buffered fallback, so the fallback is grouped
   * identically to the stream it replaces.
   *
   * REVISED 2026-07-29: this used to claim the fallback "cannot land on a
   * different provider". That was never a guarantee sticky grouping could
   * make, and it is now explicitly not the contract — endpoint failover may
   * move a session to a healthier endpoint mid-turn (owner decision, see
   * `openrouter/endpoint-failover.ts`). What IS guaranteed is that the
   * fallback and the stream share the same session identity, so the failover
   * treats them as one session and the switch stays sticky across both.
   * Which endpoint actually served a request is no longer a matter of
   * inference: it is recorded per request in `usage_log.serving_provider`.
   */
  readonly context?: InferenceRequestContext;
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  argsBuffer: string;
}

/**
 * Fresh empty response for the abort-before-any-content case. `finishReason` /
 * `generationId` / `servingProvider` are explicitly `null`, not omitted: nothing
 * was generated, so
 * "no reason reported" is the truth — and an explicit null keeps this shape
 * equivalent to the buffered path's, which always sets both.
 */
function emptyResponse(): InferenceResponse {
  return {
    content: "",
    toolCalls: null,
    usage: { ...ZERO_USAGE },
    reasoning: null,
    finishReason: null,
    generationId: null,
    servingProvider: null,
  };
}

function isAsyncIterable(value: unknown): value is AsyncIterable<StreamChunk> {
  return (
    value != null &&
    typeof (value as AsyncIterable<StreamChunk>)[Symbol.asyncIterator] ===
      "function"
  );
}

/**
 * Assemble parsed tool calls in numeric `toolCallIndex` order (NOT Map
 * insertion order). Malformed args warn + skip, mirroring
 * `parseNonStreamingResponse`; if every call is malformed the caller falls
 * through to text semantics. (On abort, an in-flight call's truncated JSON
 * fails to parse and is dropped here — partial tool calls are never assembled.)
 */
function assembleToolCalls(
  accumulator: Map<number, ToolCallAccumulator>,
): ParsedToolCall[] {
  const parsed: ParsedToolCall[] = [];
  const indices = [...accumulator.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    const entry = accumulator.get(idx)!;
    try {
      parsed.push({
        id: entry.id,
        name: entry.name,
        arguments: JSON.parse(entry.argsBuffer) as Record<string, unknown>,
      });
    } catch {
      // Never log the raw argument JSON — it can carry addresses, amounts, or
      // other user/transaction content. `JSON.parse`'s own error message also
      // echoes a fragment of the offending input, so we log a fixed reason +
      // the arg length only.
      logger.warn("inference.openrouter.malformed_tool_args", {
        name: entry.name,
        argsLength: entry.argsBuffer.length,
        reason: "invalid_json",
      });
    }
  }
  return parsed;
}

function safeOnDelta(
  onDelta: RunStreamingInferenceOptions["onDelta"],
  chunk: StreamChunk,
  sequence: number,
): void {
  if (!onDelta) return;
  try {
    onDelta(chunk, sequence);
  } catch {
    // Observation must never affect the inference result, the fallback
    // choice, or error propagation.
  }
}

/**
 * Wrap a buffered fallback completion in the streaming result shape.
 *
 * The turn's `signal` is forwarded: a fallback is still the same turn, so a
 * "stop generating" that lands after the stream degraded must cancel the
 * buffered request too. Without it the HTTP call ran to completion and billed
 * tokens for an answer nobody would read. Every caller below has already
 * short-circuited on a PRE-aborted signal, so this only covers an abort that
 * arrives DURING the fallback.
 */
async function bufferedFallback(
  provider: InferenceProvider,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  config: InferenceConfig,
  context: InferenceRequestContext | undefined,
  signal: AbortSignal | undefined,
): Promise<StreamingInferenceResult> {
  const response = await provider.chatCompletion(
    messages,
    tools,
    config,
    context,
    signal,
  );
  assertActionableInferenceResponse(response);
  return { response, aborted: false, usageObserved: true };
}

/**
 * Run inference via the streaming provider path. See module doc for the
 * fallback / abort / assembly contract.
 */
export async function runStreamingInference(
  provider: InferenceProvider,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  config: InferenceConfig,
  options: RunStreamingInferenceOptions = {},
): Promise<StreamingInferenceResult> {
  const { onDelta, signal, context } = options;

  // Pre-aborted → no inference at all; empty partial, never a fallback.
  if (signal?.aborted) {
    return { response: emptyResponse(), aborted: true, usageObserved: false };
  }

  if (typeof provider.chatCompletionStream !== "function") {
    if (signal?.aborted) {
      return { response: emptyResponse(), aborted: true, usageObserved: false };
    }
    logger.warn("inference.stream.fallback", {
      reason: "no_stream_method",
      provider: provider.id,
    });
    return bufferedFallback(provider, messages, tools, config, context, signal);
  }

  let stream: AsyncIterable<StreamChunk>;
  try {
    const candidate = provider.chatCompletionStream(messages, tools, config, signal, context);
    if (!isAsyncIterable(candidate)) {
      if (signal?.aborted) {
        return { response: emptyResponse(), aborted: true, usageObserved: false };
      }
      logger.warn("inference.stream.fallback", {
        reason: "not_async_iterable",
        provider: provider.id,
      });
      return bufferedFallback(provider, messages, tools, config, context, signal);
    }
    stream = candidate;
  } catch (err) {
    if (signal?.aborted) {
      return { response: emptyResponse(), aborted: true, usageObserved: false };
    }
    logger.warn("inference.stream.fallback", {
      reason: "setup_threw",
      provider: provider.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return bufferedFallback(provider, messages, tools, config, context, signal);
  }

  let sequence = 0;
  let observedAnyChunk = false;
  let aborted = false;
  let usageObserved = false;
  let contentSeen = false;
  let contentBuffer = "";
  let reasoningSeen = false;
  let reasoningBuffer = "";
  let usage: InferenceUsage | null = null;
  // Provider provenance carried off `done` chunks. LAST wins for the finish
  // reason (a stream can legitimately emit more than one `done`, and the final
  // one is the outcome); FIRST wins for the generation id (it identifies the
  // generation we started — see `consumeOpenRouterStream`).
  let finishReason: string | null = null;
  let generationId: string | null = null;
  // Upstream provider that served this stream (routing provenance, migration
  // 059). Like `generationId`, the FIRST value reported wins: a provider that
  // varied it mid-stream could otherwise re-attribute our usage row.
  let servingProvider: string | null = null;
  const toolCallAccumulator = new Map<number, ToolCallAccumulator>();

  try {
    for await (const chunk of stream) {
      // Check BEFORE processing so the abort is captured the moment it is
      // observed (race-free: the caller acts on `aborted`, not a later
      // signal read). An in-flight chunk at abort time is dropped.
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      observedAnyChunk = true;
      safeOnDelta(onDelta, chunk, sequence++);

      switch (chunk.type) {
        case "content":
          contentSeen = true;
          contentBuffer += chunk.text ?? "";
          break;
        case "reasoning":
          reasoningSeen = true;
          reasoningBuffer += chunk.reasoningText ?? "";
          break;
        case "tool_call_delta": {
          const idx = chunk.toolCallIndex ?? 0;
          let entry = toolCallAccumulator.get(idx);
          if (!entry) {
            entry = { id: chunk.toolCallId ?? "", name: "", argsBuffer: "" };
            toolCallAccumulator.set(idx, entry);
          }
          if (chunk.toolCallId) entry.id = chunk.toolCallId;
          if (chunk.toolCallName) entry.name = chunk.toolCallName;
          if (chunk.toolCallArgsDelta) entry.argsBuffer += chunk.toolCallArgsDelta;
          break;
        }
        case "usage":
          if (chunk.usage) {
            usage = chunk.usage;
            usageObserved = true;
          }
          break;
        case "error":
          // Provider-reported error: the delta is already emitted above.
          // This is NOT a setup failure, so we never fall back — fail.
          // `errorCode` is OpenRouter's HTTP-status-like error code (e.g. 429,
          // 502); attach it as the same lean status own-property the
          // normalizer uses so the mission classifier can auto-retry transient
          // mid-stream 429/5xx instead of pausing for a human.
          // Scrub the provider-supplied message through the same redaction
          // pipeline as normalizeOpenRouterError before surfacing it, so a
          // token/URL/body embedded in a stream error never reaches logs/UI.
          // `errorType` is OpenRouter's canonical `ApiErrorType` — an OPEN
          // enum, attached verbatim as a lean own-property in the same idiom
          // as the status (never `.cause`, never a raw provider string).
          throw attachErrorType(
            attachStatus(
              new Error(scrubMessage(chunk.errorMessage ?? "stream error") ?? "stream error"),
              chunk.errorCode,
            ),
            chunk.errorType ?? null,
          );
        case "done":
          // Assembly still happens on generator exhaustion — `done` remains
          // informational for control flow. It is now also where the provider
          // reports the finish reason and generation id, so we record them.
          if (chunk.finishReason !== undefined) finishReason = chunk.finishReason;
          if (generationId === null && chunk.generationId !== undefined) {
            generationId = chunk.generationId;
          }
          if (servingProvider === null && chunk.servingProvider !== undefined) {
            servingProvider = chunk.servingProvider;
          }
          break;
      }
    }
  } catch (err) {
    if (signal?.aborted) {
      // The abort manifested as a thrown rejection (SDK cancelled the fetch).
      // Intentional — return the partial, never rethrow or fall back.
      aborted = true;
    } else if (!observedAnyChunk) {
      // Generator rejected before yielding anything → buffered fallback.
      logger.warn("inference.stream.fallback", {
        reason: "threw_before_first_chunk",
        provider: provider.id,
        error: err instanceof Error ? err.message : String(err),
      });
      return bufferedFallback(provider, messages, tools, config, context, signal);
    } else {
      throw err;
    }
  }

  const resolvedUsage = usage ?? ZERO_USAGE;
  const reasoning = reasoningSeen ? reasoningBuffer : null;
  const toolCalls = assembleToolCalls(toolCallAccumulator);

  const response: InferenceResponse =
    toolCalls.length > 0
      ? {
          // Tool path — content is null when no text accompanied the calls
          // (parity with `parseNonStreamingResponse`).
          content: contentSeen ? contentBuffer : null,
          toolCalls,
          usage: resolvedUsage,
          reasoning,
          finishReason,
          generationId,
          servingProvider,
        }
      : {
          // Text path — content defaults to "" when no content delta arrived.
          content: contentBuffer,
          toolCalls: null,
          usage: resolvedUsage,
          reasoning,
          finishReason,
          generationId,
          servingProvider,
        };

  // A normal, non-aborted completion must contain final text or at least one
  // valid tool call. Without this guard the engine treats an empty completion
  // as "keep iterating" and can silently repeat the same paid request until
  // the broad 50-iteration / 10-minute runtime bound fires.
  if (!aborted) assertActionableInferenceResponse(response);

  return { response, aborted, usageObserved };
}
