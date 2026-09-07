/**
 * Validate an OpenRouter stream before declaring its endpoint healthy, within
 * a BOUNDED prefix.
 *
 * WHY THIS EXISTS. `sendWithEndpointFailover` historically considered the HTTP
 * stream handle a success before the stream produced any model output. Some
 * upstreams return a syntactically valid stream carrying only usage + `done`;
 * the engine then received an empty completion and silently issued the same
 * paid turn again. So the failover's success point moves from "a handle
 * exists" to "the first MEANINGFUL delta exists": until then no user-visible
 * byte has been emitted, which is exactly what makes a retry safe.
 *
 * WHY THE BOUND. Waiting for that first delta means RETAINING the chunks seen
 * before it, so they can be replayed to the consumer. An unbounded wait is an
 * unbounded buffer: a provider that streams whitespace-only deltas forever
 * grows this array without limit (100,001 chunks were retained in a
 * reproduction of the unbounded version). Retention is therefore capped on
 * BOTH axes that can grow independently (rule 05): chunk count and UTF-8
 * bytes. Crossing either cap fails the attempt with
 * {@link OpenRouterEmptyStreamError}, naming the bound and the counts seen.
 *
 * NOTHING IS EVER TRUNCATED. Below the bound the whole buffered prefix is
 * replayed, in order, before the live stream continues. At the bound the
 * stream FAILS; it never yields a silently shortened answer. The two outcomes
 * are the only two.
 *
 * WHY 502. Both failures (`stream_exhausted`, `prefix_bound_exceeded`) mean
 * "this endpoint produced no usable output". Status 502 puts them in the
 * existing bounded capacity-failure policy
 * (`endpoint-failover/capacity-failure.ts`: `provider_unavailable`,
 * switchable), so the attempt retries and can rotate to a sibling endpoint
 * instead of ending the turn in the user's face. No user-visible delta was
 * emitted, so the retry cannot duplicate an answer.
 */

import type { StreamChunk } from "../types.js";
import { throwIfAborted } from "@utils/cancellation.js";
import logger from "@utils/logger.js";
import { attachStatus } from "./errors.js";

/**
 * Maximum number of prefix chunks retained while waiting for the first
 * meaningful delta.
 *
 * The repository's provider notes record no measured reasoning-only or
 * whitespace-only prefix length for OpenRouter, so this is a CONSERVATIVE
 * value rather than a measured one: only chunks that carry nothing actionable
 * (usage-only chunks, whitespace-only content/reasoning deltas, a non-terminal
 * `done`) are counted, and a healthy stream emits at most a handful of those
 * before its first token. 64 leaves two orders of magnitude of headroom below
 * the reproduced runaway while capping retention at kilobytes.
 */
export const MAX_EMPTY_PREFIX_CHUNKS = 64;

/**
 * Maximum UTF-8 bytes of prefix text retained while waiting for the first
 * meaningful delta. Measured independently of the chunk count because either
 * axis can grow on its own: one 10 MB whitespace delta is a single chunk.
 * Conservative for the same reason as {@link MAX_EMPTY_PREFIX_CHUNKS}.
 */
export const MAX_EMPTY_PREFIX_BYTES = 64 * 1024;

/** Why a stream never produced a meaningful delta. Bounded vocabulary. */
export type EmptyStreamReason =
  /** The stream ended before any meaningful delta arrived. */
  | "stream_exhausted"
  /** The retention bound was reached before any meaningful delta arrived. */
  | "prefix_bound_exceeded";

/**
 * A typed provider failure: this OpenRouter stream produced no output the
 * engine could act on. Carries the counts and the bound that produced the
 * verdict so a log line, a test and an operator all read the same numbers
 * instead of parsing a message.
 *
 * The message contains integers only, never provider text, so it is safe to
 * surface without passing through `scrubMessage`.
 */
export class OpenRouterEmptyStreamError extends Error {
  readonly reason: EmptyStreamReason;
  /** Prefix chunks seen (and retained) before the failure. */
  readonly chunksSeen: number;
  /** UTF-8 bytes of prefix text seen (and retained) before the failure. */
  readonly bytesSeen: number;
  readonly maxChunks: number;
  readonly maxBytes: number;

  constructor(args: {
    readonly reason: EmptyStreamReason;
    readonly chunksSeen: number;
    readonly bytesSeen: number;
  }) {
    super(
      args.reason === "stream_exhausted"
        ? "OpenRouter streaming chat completion failed: empty response"
        : "OpenRouter streaming chat completion failed: no meaningful delta within the bounded prefix "
          + `(bound ${MAX_EMPTY_PREFIX_CHUNKS} chunks / ${MAX_EMPTY_PREFIX_BYTES} bytes; `
          + `seen ${args.chunksSeen} chunks / ${args.bytesSeen} bytes)`,
    );
    this.name = "OpenRouterEmptyStreamError";
    this.reason = args.reason;
    this.chunksSeen = args.chunksSeen;
    this.bytesSeen = args.bytesSeen;
    this.maxChunks = MAX_EMPTY_PREFIX_CHUNKS;
    this.maxBytes = MAX_EMPTY_PREFIX_BYTES;
    // Read by `classifyCapacityFailure` off the lean own-properties, exactly
    // like a normalized SDK error.
    attachStatus(this, 502);
  }
}

function hasMeaningfulDelta(chunk: StreamChunk): boolean {
  if (chunk.type === "content") return (chunk.text ?? "").trim().length > 0;
  if (chunk.type === "reasoning") {
    return (chunk.reasoningText ?? "").trim().length > 0;
  }
  if (chunk.type === "tool_call_delta") return true;
  // A policy stop is a real terminal answer, even when it contains no text.
  // Let the ordinary completion validator surface it without rotating through
  // sibling endpoints that must enforce the same policy.
  if (chunk.type === "done" && chunk.finishReason === "content_filter") {
    return true;
  }
  // Error chunks retain their existing normalization/classification path.
  if (chunk.type === "error") return true;
  return false;
}

/** UTF-8 size of the text a retained chunk actually holds. */
function retainedChunkBytes(chunk: StreamChunk): number {
  let bytes = 0;
  if (chunk.text !== undefined) bytes += Buffer.byteLength(chunk.text, "utf8");
  if (chunk.reasoningText !== undefined) {
    bytes += Buffer.byteLength(chunk.reasoningText, "utf8");
  }
  if (chunk.toolCallArgsDelta !== undefined) {
    bytes += Buffer.byteLength(chunk.toolCallArgsDelta, "utf8");
  }
  return bytes;
}

/**
 * Release the source. Idempotent for a generator, and its own failure never
 * replaces the primary one (rule 05: collect, do not hide).
 */
async function closeIterator(iterator: AsyncIterator<StreamChunk>): Promise<void> {
  try {
    await iterator.return?.();
  } catch (err) {
    logger.warn("inference.openrouter.stream_release_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function* replayBufferedStream(
  buffered: readonly StreamChunk[],
  iterator: AsyncIterator<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  try {
    // The WHOLE retained prefix, in order. Nothing is dropped: the only other
    // outcome this module has is a thrown `OpenRouterEmptyStreamError`.
    for (const chunk of buffered) yield chunk;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await closeIterator(iterator);
  }
}

/**
 * Pull an OpenRouter stream until its first meaningful delta and hand back a
 * stream that replays the retained prefix and then continues live.
 *
 * Rejects with {@link OpenRouterEmptyStreamError} (status 502) when the stream
 * ends first or the retention bound is reached first, and with the signal's
 * own reason when the caller aborts while we wait. Every exit path - success,
 * empty, bound, abort, source rejection - releases the source iterator and the
 * retained prefix.
 *
 * @param signal the turn's abort signal, observed between chunks. A pending
 * `next()` cannot be cancelled from here; the SDK's own abort handling rejects
 * it, and this check makes the intent explicit for sources that do not.
 */
export async function requireNonEmptyOpenRouterStream(
  stream: AsyncIterable<StreamChunk>,
  signal?: AbortSignal,
): Promise<AsyncIterable<StreamChunk>> {
  const iterator = stream[Symbol.asyncIterator]();
  let buffered: StreamChunk[] = [];
  let bufferedBytes = 0;

  const releaseAndThrow = async (error: unknown): Promise<never> => {
    buffered = [];
    await closeIterator(iterator);
    throw error;
  };

  for (;;) {
    // A caller Stop between chunks: release before it propagates.
    // `throwIfAborted` throws the SIGNAL'S OWN reason, so an operator Stop
    // (AbortError) stays distinguishable from a deadline breach
    // (TimeoutError) exactly as everywhere else in the inference path.
    try {
      throwIfAborted(signal);
    } catch (err) {
      return await releaseAndThrow(err);
    }

    let next: IteratorResult<StreamChunk>;
    try {
      next = await iterator.next();
    } catch (err) {
      // Source rejection (dropped connection, abort surfaced as a rejection):
      // release, then let the existing normalization path classify it.
      return await releaseAndThrow(err);
    }

    if (next.done) {
      logger.warn("inference.openrouter.empty_stream", {
        reason: "stream_exhausted",
        chunksSeen: buffered.length,
        bytesSeen: bufferedBytes,
      });
      return await releaseAndThrow(
        new OpenRouterEmptyStreamError({
          reason: "stream_exhausted",
          chunksSeen: buffered.length,
          bytesSeen: bufferedBytes,
        }),
      );
    }

    const chunk = next.value;
    if (hasMeaningfulDelta(chunk)) {
      buffered.push(chunk);
      return replayBufferedStream(buffered, iterator);
    }

    // Bound checked BEFORE retaining, so the caps are what we hold, not what
    // we hold plus one.
    const chunkBytes = retainedChunkBytes(chunk);
    if (
      buffered.length + 1 > MAX_EMPTY_PREFIX_CHUNKS ||
      bufferedBytes + chunkBytes > MAX_EMPTY_PREFIX_BYTES
    ) {
      logger.warn("inference.openrouter.empty_stream", {
        reason: "prefix_bound_exceeded",
        chunksSeen: buffered.length,
        bytesSeen: bufferedBytes,
        maxChunks: MAX_EMPTY_PREFIX_CHUNKS,
        maxBytes: MAX_EMPTY_PREFIX_BYTES,
      });
      return await releaseAndThrow(
        new OpenRouterEmptyStreamError({
          reason: "prefix_bound_exceeded",
          chunksSeen: buffered.length,
          bytesSeen: bufferedBytes,
        }),
      );
    }

    buffered.push(chunk);
    bufferedBytes += chunkBytes;
  }
}
