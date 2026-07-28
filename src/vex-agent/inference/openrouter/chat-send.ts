/**
 * Narrowing boundary for `chat.send`'s response union.
 *
 * WHY this module exists. Up to `@openrouter/sdk@0.12.79` the three `send`
 * overloads narrowed their RETURN type from the literal type of `stream`:
 * `stream: false` resolved to `Promise<ChatResult>` and `stream: true` to
 * `Promise<EventStream<ChatStreamChunk>>`, so our call sites needed no casts.
 * In `1.1.13` all three overloads declare
 * `Promise<SendChatCompletionRequestResponse>` — the bare
 * `ChatResult | EventStream<ChatStreamChunk>` union (verified by diffing
 * `esm/sdk/chat.d.ts` across the two installed versions).
 *
 * The RUNTIME is unchanged: `SendChatCompletionRequestResponse$inboundSchema`
 * is still the same two-arm zod union that returns an `EventStream` for a
 * `ReadableStream` body and a parsed `ChatResult` otherwise. Only the static
 * narrowing was lost.
 *
 * So we re-establish it with a runtime type guard rather than an `as` cast
 * (`rules/03`: prefer type guards over unsafe casts). A cast would silently
 * hand a `ReadableStream` to code that expects `.choices` if the SDK ever
 * disagreed with us; the guard turns that into a loud, named error at the
 * exact boundary where the assumption lives.
 */

import type { EventStream } from "@openrouter/sdk/lib/event-streams.js";
import type { ChatResult } from "@openrouter/sdk/models/chatresult.js";
import type { ChatStreamChunk } from "@openrouter/sdk/models/chatstreamchunk.js";
import type { SendChatCompletionRequestResponse } from "@openrouter/sdk/models/operations/sendchatcompletionrequest.js";

/**
 * Discriminate the union STRUCTURALLY, on the async-iterability we actually
 * consume, rather than with `instanceof EventStream`.
 *
 * `ChatResult` is a plain parsed object and never async-iterable, so the two
 * arms are cleanly separated by this property. Structural narrowing is also
 * robust to a duplicated SDK copy in the module graph, where `instanceof`
 * against a different realm's class would fail on a perfectly valid stream and
 * turn a working request into a spurious error.
 */
function isEventStreamResponse(
  response: SendChatCompletionRequestResponse,
): response is EventStream<ChatStreamChunk> {
  return (
    typeof (response as { [Symbol.asyncIterator]?: unknown })[
      Symbol.asyncIterator
    ] === "function"
  );
}

/**
 * Narrow a `stream: false` send to its buffered `ChatResult`.
 * Throws when the SDK unexpectedly returned a stream.
 */
export function asChatResult(
  response: SendChatCompletionRequestResponse,
  operation: string,
): ChatResult {
  if (isEventStreamResponse(response)) {
    throw new Error(
      `OpenRouter ${operation} failed: expected a buffered completion but the SDK returned a stream`,
    );
  }
  return response;
}

/**
 * Narrow a `stream: true` send to its `EventStream<ChatStreamChunk>`.
 * Throws when the SDK unexpectedly returned a buffered result.
 */
export function asEventStream(
  response: SendChatCompletionRequestResponse,
  operation: string,
): EventStream<ChatStreamChunk> {
  if (!isEventStreamResponse(response)) {
    throw new Error(
      `OpenRouter ${operation} failed: expected a stream but the SDK returned a buffered completion`,
    );
  }
  return response;
}
