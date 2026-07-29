/**
 * OpenRouter post-SDK stream-consumption loop.
 *
 * Consumes the SDK's `EventStream<ChatStreamChunk>` (returned by
 * `client.chat.send` with `stream: true`) and yields provider-agnostic
 * `StreamChunk` instances. The tool-call delta accumulation lives here; the
 * provider's `chatCompletionStream` method performs the SDK send (with error
 * normalization) and delegates the consumption loop to this function.
 */

import type { ChatStreamChunk } from "@openrouter/sdk/models/chatstreamchunk.js";
import type { EventStream } from "@openrouter/sdk/lib/event-streams.js";

import type { StreamChunk } from "../types.js";

import { extractUsage, processToolCallDelta } from "./mappers.js";
import {
  boundedErrorType,
  boundedFinishReason,
  boundedGenerationId,
} from "./provider-signals.js";
import { observeRoutingMetadata } from "./routing-metadata.js";

export async function* consumeOpenRouterStream(
  stream: EventStream<ChatStreamChunk>,
): AsyncGenerator<StreamChunk> {
  // Accumulate tool call deltas by index
  const toolCallAccumulator = new Map<number, {
    id: string;
    name: string;
    argsBuffer: string;
  }>();

  // The generation id is echoed on every SSE chunk (OpenAI-compatible
  // `chat.completion.chunk` semantics). We keep the FIRST non-empty one: it
  // identifies the generation we actually started, so a provider that varied
  // it mid-stream could never retroactively re-attribute our usage row.
  let generationId: string | null = null;
  // Routing metadata (`xOpenRouterMetadata: enabled`) rides the stream too.
  // Log it once — repeating it per chunk would be pure noise.
  let routingMetadataLogged = false;

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta;

    if (generationId === null) generationId = boundedGenerationId(chunk.id);

    if (!routingMetadataLogged && chunk.openrouterMetadata) {
      observeRoutingMetadata(chunk.openrouterMetadata, "streaming chat completion");
      routingMetadataLogged = true;
    }

    // Error on chunk
    if (chunk.error) {
      const errorType = boundedErrorType(chunk.error.metadata?.errorType);
      yield {
        type: "error",
        errorMessage: chunk.error.message,
        errorCode: chunk.error.code,
        ...(errorType !== null && { errorType }),
      };
      continue;
    }

    // Text content delta
    if (delta?.content) {
      yield { type: "content", text: delta.content };
    }

    // Reasoning delta
    if (delta?.reasoning) {
      yield { type: "reasoning", reasoningText: delta.reasoning };
    }

    // Tool call deltas — accumulate by index
    if (delta?.toolCalls) {
      for (const tc of delta.toolCalls) {
        yield* processToolCallDelta(tc, toolCallAccumulator);
      }
    }

    // Usage (typically in last chunk)
    if (chunk.usage) {
      yield { type: "usage", usage: extractUsage(chunk.usage) };
    }

    // Finish reason. `ChatFinishReasonEnum` is an OPEN enum, so this is
    // deliberately NOT a membership test against a closed set: ANY reason the
    // provider reports ends the completion and is carried through as data —
    // `length` (truncated), `content_filter`, and labels this SDK version does
    // not enumerate included. Previously only `stop`/`tool_calls` produced a
    // `done` chunk, so a truncated answer looked exactly like a complete one.
    // Carrying it changes no turn-loop behaviour here; it is recorded and
    // logged (acting on `length` is a separate product decision).
    const finishReason = boundedFinishReason(chunk.choices?.[0]?.finishReason);
    if (finishReason !== null) {
      // done signals completion — the engine assembles final tool calls.
      yield {
        type: "done",
        finishReason,
        ...(generationId !== null && { generationId }),
      };
    }
  }
}
