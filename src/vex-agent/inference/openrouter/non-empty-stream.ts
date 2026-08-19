/**
 * Validate an OpenRouter stream before declaring its endpoint healthy.
 *
 * `sendWithEndpointFailover` historically considered the HTTP stream handle a
 * success before the stream produced any model output. Some upstreams return a
 * syntactically valid stream containing only usage + `done`; the engine then
 * received an empty completion and silently issued the same turn again.
 *
 * We pull only until the first meaningful delta. If there is one, the buffered
 * prefix is replayed and streaming continues normally. If the stream exhausts
 * first, a lean synthetic 502 enters the existing bounded endpoint-failover
 * policy. No user-visible bytes were emitted, so retrying cannot duplicate an
 * answer.
 */

import type { StreamChunk } from "../types.js";
import { attachStatus } from "./errors.js";

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

function emptyStreamError(): Error {
  return attachStatus(
    new Error("OpenRouter streaming chat completion failed: empty response"),
    502,
  );
}

async function* replayBufferedStream(
  buffered: readonly StreamChunk[],
  iterator: AsyncIterator<StreamChunk>,
): AsyncGenerator<StreamChunk> {
  try {
    for (const chunk of buffered) yield chunk;
    for (;;) {
      const next = await iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await iterator.return?.();
  }
}

export async function requireNonEmptyOpenRouterStream(
  stream: AsyncIterable<StreamChunk>,
): Promise<AsyncIterable<StreamChunk>> {
  const iterator = stream[Symbol.asyncIterator]();
  const buffered: StreamChunk[] = [];

  for (;;) {
    const next = await iterator.next();
    if (next.done) {
      await iterator.return?.();
      throw emptyStreamError();
    }
    buffered.push(next.value);
    if (hasMeaningfulDelta(next.value)) {
      return replayBufferedStream(buffered, iterator);
    }
  }
}
