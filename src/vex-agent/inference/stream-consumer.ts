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
 *
 * Stream bounds (Kairos Phase 2B, `round-guard.ts`): one guard per round
 * enforces the first-chunk, idle, reasoning-only and round-deadline bounds
 * from the config. A bound that fires aborts ONLY the guard's request-local
 * signal and the round is RETURNED (never thrown) with `timedOut` set: the
 * text that streamed, no tool calls, no finish reason. The buffered fallback
 * runs only on a genuine stream incompatibility (no stream method, a
 * non-iterable stream, or a setup / pre-first-chunk failure that is not a
 * timeout, deadline or abort) and gets only the round budget that is left.
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
import { isInferenceTimeout, type InferenceAttemptTimer } from "./attempt-timing.js";
import type { InferenceStallKind } from "./inference-timeout.js";
import { createRoundGuard, roundBoundsFrom, STALLED, type RoundGuard } from "./round-guard.js";
import { isAbortError } from "@utils/cancellation.js";

export type { InferenceStallKind } from "./inference-timeout.js";

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
  /**
   * The Kairos bound that stopped this round (Phase 2B), or `null` when none
   * fired. A timed-out round is RETURNED, not thrown: `aborted` is false, the
   * response is the partial text that streamed (possibly ""), it never
   * carries tool calls, and `finishReason` is null. A caller Stop always wins:
   * `aborted: true` with `timedOut: null`.
   */
  readonly timedOut: InferenceStallKind | null;
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
  /**
   * Runtime-measurement observer (Kairos Phase 1). Fed request start, every
   * chunk's TYPE, the buffered-fallback reason, capacity failures absorbed by
   * the endpoint failover, and tool-call counts. Observation only: a throwing
   * timer never affects the result, the fallback choice or error propagation,
   * and leaving it out changes nothing.
   */
  readonly timing?: InferenceAttemptTimer;
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
    malformedToolCallCount: 0,
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
 * insertion order). Malformed calls warn + skip, mirroring
 * `parseNonStreamingResponse`, and are COUNTED so the turn loop can refuse the
 * whole batch; if every call is malformed the caller falls through to text
 * semantics. (On abort, an in-flight call's truncated JSON fails to parse and
 * is dropped here — partial tool calls are never assembled.)
 *
 * A call the stream never gave an id or a name is malformed too: its result
 * could not be paired with it in the transcript, and there is nothing to
 * dispatch. No id is invented for it.
 */
function assembleToolCalls(
  accumulator: Map<number, ToolCallAccumulator>,
): { parsed: ParsedToolCall[]; malformed: number } {
  const parsed: ParsedToolCall[] = [];
  let malformed = 0;
  const indices = [...accumulator.keys()].sort((a, b) => a - b);
  for (const idx of indices) {
    const entry = accumulator.get(idx)!;
    if (entry.id.length === 0 || entry.name.length === 0) {
      malformed += 1;
      logger.warn("inference.openrouter.malformed_tool_args", {
        name: entry.name,
        argsLength: entry.argsBuffer.length,
        reason: entry.id.length === 0 ? "missing_id" : "missing_name",
      });
      continue;
    }
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
      malformed += 1;
      logger.warn("inference.openrouter.malformed_tool_args", {
        name: entry.name,
        argsLength: entry.argsBuffer.length,
        reason: "invalid_json",
      });
    }
  }
  return { parsed, malformed };
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
 * Invoke one timer mark, swallowing anything it throws — the `safeOnDelta`
 * contract applied to the measurement observer.
 */
function safeTiming(
  timing: InferenceAttemptTimer | undefined,
  mark: (timer: InferenceAttemptTimer) => void,
): void {
  if (!timing) return;
  try {
    mark(timing);
  } catch {
    // Measurement must never affect inference.
  }
}

/**
 * The request context with the timer's capacity-failure hook added, so the
 * endpoint failover reports each capacity failure it absorbs. Without a timer
 * (or without a context — there is no session to attribute a retry to, and
 * inventing one would change sticky routing) the context passes through as-is.
 */
function withCapacityHook(
  context: InferenceRequestContext | undefined,
  timing: InferenceAttemptTimer | undefined,
): InferenceRequestContext | undefined {
  if (!timing || context === undefined) return context;
  return {
    ...context,
    onCapacityFailure: (reasonClass) => {
      safeTiming(timing, (t) => t.markCapacityFailure(reasonClass));
    },
  };
}

/**
 * The streaming result for a round a Kairos bound stopped: the text that
 * streamed (possibly ""), NEVER a tool call (in-flight calls are dropped, as
 * on a user Stop, because a truncated batch must not be dispatched), and no
 * finish reason (the provider never finished). Usage is kept only when its
 * chunk had already arrived.
 */
function timedOutResult(
  kind: InferenceStallKind,
  partial: {
    readonly content: string;
    readonly reasoning: string | null;
    readonly usage: InferenceUsage | null;
    readonly generationId: string | null;
    readonly servingProvider: string | null;
  },
): StreamingInferenceResult {
  return {
    response: {
      content: partial.content,
      toolCalls: null,
      usage: partial.usage ?? { ...ZERO_USAGE },
      reasoning: partial.reasoning,
      finishReason: null,
      generationId: partial.generationId,
      servingProvider: partial.servingProvider,
      malformedToolCallCount: 0,
    },
    aborted: false,
    usageObserved: partial.usage !== null,
    timedOut: kind,
  };
}

const NOTHING_STREAMED = {
  content: "",
  reasoning: null,
  usage: null,
  generationId: null,
  servingProvider: null,
} as const;

/**
 * True when a failure before the first chunk means the provider cannot stream
 * this request, so a buffered request is worth trying. A timeout, a deadline
 * or an abort is NOT: the provider was reachable and slow (or the request was
 * cancelled), and a buffered retry would only spend the same wait again.
 */
function isStreamIncompatibility(err: unknown): boolean {
  if (isInferenceTimeout(err) || isAbortError(err)) return false;
  const name = err instanceof Error ? err.name : undefined;
  return name !== "RequestAbortedError";
}

/**
 * Wrap a buffered fallback completion in the streaming result shape.
 *
 * The round's `signal` is forwarded: a fallback is still the same round, so a
 * "stop generating" that lands after the stream degraded must cancel the
 * buffered request too, and the round deadline keeps running — the fallback
 * gets only the budget that is LEFT, never a fresh one (R-6). Every caller
 * below has already short-circuited on a PRE-aborted signal, so this only
 * covers an abort that arrives DURING the fallback.
 */
async function bufferedFallback(
  provider: InferenceProvider,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  config: InferenceConfig,
  context: InferenceRequestContext | undefined,
  guard: RoundGuard,
  callerSignal: AbortSignal | undefined,
  reason: string,
  timing: InferenceAttemptTimer | undefined,
  cause?: unknown,
): Promise<StreamingInferenceResult> {
  guard.enterBuffered();
  if (guard.timedOut !== null) return timedOutResult(guard.timedOut, NOTHING_STREAMED);
  logger.warn("inference.stream.fallback", {
    reason,
    provider: provider.id,
    ...(cause !== undefined && {
      error: cause instanceof Error ? cause.message : String(cause),
    }),
  });
  safeTiming(timing, (t) => t.markBufferedFallback(reason));
  try {
    const response = await guard.race(
      provider.chatCompletion(messages, tools, config, context, guard.signal),
    );
    if (response === STALLED) return stalledResult(guard);
    return { response, aborted: false, usageObserved: true, timedOut: null };
  } catch (err) {
    // The round deadline firing mid-request surfaces as the SDK's timeout
    // error; it is the bound's verdict, not a provider failure.
    if (guard.timedOut !== null && callerSignal?.aborted !== true) {
      return timedOutResult(guard.timedOut, NOTHING_STREAMED);
    }
    throw err;
  }
}

/** Result for a `race` the guard won before anything streamed. */
function stalledResult(guard: RoundGuard): StreamingInferenceResult {
  return timedOutResult(guard.timedOut ?? "round_deadline", NOTHING_STREAMED);
}

/**
 * Release an iterator the round abandoned. Never awaited when a bound fired:
 * its pending `next()` may never settle, and waiting on it is exactly the
 * hang the bound exists to end. Its signal is already aborted.
 */
function releaseAbandoned(iterator: AsyncIterator<StreamChunk>): void {
  try {
    const returned = iterator.return?.();
    if (returned !== undefined) void Promise.resolve(returned).catch(() => {});
  } catch {
    // Releasing is best-effort; the round's outcome is already decided.
  }
}

/**
 * Run inference via the streaming provider path. See module doc for the
 * fallback / abort / assembly contract, and `round-guard.ts` for the bounds.
 */
export async function runStreamingInference(
  provider: InferenceProvider,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  config: InferenceConfig,
  options: RunStreamingInferenceOptions = {},
): Promise<StreamingInferenceResult> {
  const { signal, timing } = options;
  safeTiming(timing, (t) => t.markRequestStart());

  // Pre-aborted → no inference at all; empty partial, never a fallback.
  if (signal?.aborted) {
    return { response: emptyResponse(), aborted: true, usageObserved: false, timedOut: null };
  }

  // ONE guard for the whole round, created before the first send so the round
  // deadline also covers failover retries, backoff sleeps and the fallback.
  const guard = createRoundGuard(roundBoundsFrom(config), signal);
  guard.start();
  try {
    const result = await runGuardedInference(provider, messages, tools, config, options, guard);
    if (result.timedOut !== null) {
      logger.warn("inference.stream.timed_out", {
        provider: provider.id,
        kind: result.timedOut,
        contentChars: (result.response.content ?? "").length,
        usageObserved: result.usageObserved,
      });
    }
    return result;
  } finally {
    // Every exit path: success, timeout, abort, fallback, throw.
    guard.dispose();
  }
}

async function runGuardedInference(
  provider: InferenceProvider,
  messages: ProviderMessage[],
  tools: ToolDefinition[],
  config: InferenceConfig,
  options: RunStreamingInferenceOptions,
  guard: RoundGuard,
): Promise<StreamingInferenceResult> {
  const { onDelta, signal, timing } = options;
  const context = withCapacityHook(options.context, timing);
  const fallback = (reason: string, cause?: unknown): Promise<StreamingInferenceResult> =>
    bufferedFallback(
      provider, messages, tools, config, context, guard, signal, reason, timing, cause,
    );

  if (typeof provider.chatCompletionStream !== "function") {
    return fallback("no_stream_method");
  }

  let stream: AsyncIterable<StreamChunk>;
  try {
    const candidate = provider.chatCompletionStream(messages, tools, config, guard.signal, context);
    if (!isAsyncIterable(candidate)) {
      if (signal?.aborted) {
        return { response: emptyResponse(), aborted: true, usageObserved: false, timedOut: null };
      }
      return fallback("not_async_iterable");
    }
    stream = candidate;
  } catch (err) {
    if (signal?.aborted) {
      return { response: emptyResponse(), aborted: true, usageObserved: false, timedOut: null };
    }
    if (guard.timedOut !== null) return timedOutResult(guard.timedOut, NOTHING_STREAMED);
    if (!isStreamIncompatibility(err)) throw err;
    return fallback("setup_threw", err);
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

  const partial = () => ({
    content: contentBuffer,
    reasoning: reasoningSeen ? reasoningBuffer : null,
    usage,
    generationId,
    servingProvider,
  });

  // Iterated by hand rather than with `for await`, so a fired bound can end
  // the wait on a `next()` the source never settles (see `RoundGuard.race`).
  const iterator = stream[Symbol.asyncIterator]();
  // True once the source is finished or released, so it is released once.
  let released = false;
  // True only while waiting on the source: a rejection there has already
  // finished it, while a throw from the loop body (an error chunk) has not.
  let awaitingSource = false;
  try {
    for (;;) {
      awaitingSource = true;
      const next = await guard.race(iterator.next());
      awaitingSource = false;
      if (next === STALLED) {
        released = true;
        releaseAbandoned(iterator);
        break;
      }
      if (next.done) {
        released = true;
        break;
      }
      const chunk = next.value;
      // Arrival time, before the abort check: a chunk that lands after Stop
      // still arrived, and the gap leading up to it is real latency.
      safeTiming(timing, (t) => t.markChunk(chunk.type));
      // Check BEFORE processing so the abort is captured the moment it is
      // observed (race-free: the caller acts on `aborted`, not a later
      // signal read). An in-flight chunk at abort time is dropped.
      if (signal?.aborted) {
        aborted = true;
        break;
      }
      // A bound fired while this chunk was in flight: the round is over, and
      // a chunk that arrives after the verdict is dropped like one after Stop.
      if (guard.timedOut !== null) break;
      guard.onChunk(chunk.type);
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
    // A rejected `next()` has already finished the source.
    if (awaitingSource) released = true;
    if (signal?.aborted) {
      // The abort manifested as a thrown rejection (SDK cancelled the fetch).
      // Intentional — return the partial, never rethrow or fall back.
      aborted = true;
    } else if (guard.timedOut !== null) {
      // The bound's own abort surfaced as a rejection (the SDK's timeout
      // error, or the failover's capacity error after its backoff sleep was
      // cut short). The bound is the verdict; handled below.
    } else if (!observedAnyChunk) {
      // Rejected before yielding anything. Only a genuine stream failure earns
      // a buffered retry; a timeout or abort propagates as itself.
      if (!isStreamIncompatibility(err)) throw err;
      return fallback("threw_before_first_chunk", err);
    } else {
      throw err;
    }
  } finally {
    // Every other early exit (Stop, a chunk after a bound, an error chunk):
    // release the source exactly as `for await` did on `break` / `throw`.
    if (!released) {
      released = true;
      if (guard.timedOut !== null) releaseAbandoned(iterator);
      else await iterator.return?.();
    }
  }

  if (!aborted && guard.timedOut !== null) {
    // Tool calls in flight are dropped, never assembled, never counted as
    // malformed: they were cut off, not written wrong.
    safeTiming(timing, (t) => t.markToolCalls(toolCallAccumulator.size, 0));
    return timedOutResult(guard.timedOut, partial());
  }

  const resolvedUsage = usage ?? ZERO_USAGE;
  const reasoning = reasoningSeen ? reasoningBuffer : null;
  const { parsed: toolCalls, malformed: malformedToolCallCount } =
    assembleToolCalls(toolCallAccumulator);
  safeTiming(timing, (t) => t.markToolCalls(toolCallAccumulator.size, toolCalls.length));

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
          malformedToolCallCount,
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
          malformedToolCallCount,
        };

  // A completion with no final text and no valid tool call is returned AS a
  // completion, never as an error. Whether the engine may ask the same
  // question again is the turn loop's decision, and it already owns one: the
  // consecutive-blank detector (`engine/core/runner/unproductive-rounds.ts`)
  // counts this round as blank and stops the turn with `no_progress` on the
  // third in a row. Rejecting here would pre-empt that bound with a hard
  // error, which is why this layer stays a transport.
  return { response, aborted, usageObserved, timedOut: null };
}
