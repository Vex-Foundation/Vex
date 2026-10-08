/**
 * Shared fixtures for the reasoning-replay (Kairos R-7) suites.
 *
 * Everything here drives the REAL `@openrouter/sdk` client with an
 * intercepted fetcher, so the assertions cover the SDK's own outbound
 * (camelCase to snake_case) and inbound (SSE and JSON parse) schemas rather
 * than our composition of them.
 */

import { OpenRouter, HTTPClient } from "@openrouter/sdk";
import type { ChatRequest } from "@openrouter/sdk/models/chatrequest.js";
import type { ChatResult } from "@openrouter/sdk/models/chatresult.js";
import type { ReasoningDetailUnion } from "@openrouter/sdk/models/reasoningdetailunion.js";

import { asChatResult, asEventStream } from "@vex-agent/inference/openrouter/chat-send.js";
import { consumeOpenRouterStream } from "@vex-agent/inference/openrouter/stream.js";
import type {
  InferenceConfig,
  ProviderMessage,
  StreamChunk,
  ToolDefinition,
} from "@vex-agent/inference/types.js";

export function configFor(model: string): InferenceConfig {
  return {
    provider: "openrouter",
    model,
    contextLimit: 200_000,
    maxOutputTokens: 4096,
    inputPricePerM: 3,
    outputPricePerM: 15,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
  };
}

export const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wallet_balance",
      description: "Read a wallet balance",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

/** Per-family detail sequences, in the shapes OpenRouter documents. */
export const FAMILY_DETAILS: Record<string, ReasoningDetailUnion[]> = {
  "anthropic/claude-sonnet-4.5": [
    {
      type: "reasoning.text",
      text: "Check the balance first.",
      signature: "sig-anthropic-1",
      format: "anthropic-claude-v1",
      index: 0,
    },
    { type: "reasoning.encrypted", data: "cmVkYWN0ZWQtdGhpbmtpbmc=", format: "anthropic-claude-v1", index: 1 },
  ],
  "openai/gpt-5": [
    { type: "reasoning.summary", summary: "Plan: read balance.", id: "rs_1", format: "openai-responses-v1", index: 0 },
    { type: "reasoning.encrypted", data: "gAAAAB-openai-opaque", id: "rs_1", format: "openai-responses-v1", index: 1 },
  ],
  "google/gemini-3-pro-preview": [
    { type: "reasoning.encrypted", data: "gemini-thought-signature", format: "google-gemini-v1", index: 0 },
  ],
  "x-ai/grok-4": [
    { type: "reasoning.encrypted", data: "xai-opaque", id: "rs_x", format: "xai-responses-v1", index: 0 },
  ],
  "deepseek/deepseek-v4-flash": [
    { type: "reasoning.text", text: "User wants a balance; call the tool.", format: "unknown", index: 0 },
  ],
};

/** A two-round tool-loop tape; `replay` rides on the assistant tool-call row. */
export function toolLoopMessages(
  replay: ProviderMessage["reasoningReplay"],
): ProviderMessage[] {
  const assistant: ProviderMessage = {
    role: "assistant",
    content: "",
    toolCalls: [{ id: "call_1", command: "wallet_balance", args: {} }],
  };
  if (replay !== undefined) assistant.reasoningReplay = replay;
  return [
    { role: "system", content: "SYS", cacheHint: "static_prefix" },
    { role: "user", content: "what is my balance?" },
    assistant,
    { role: "tool", content: "{\"usd\":12}", toolCallId: "call_1", cacheHint: "history_tail" },
    { role: "system", content: "TURN STATE", cacheHint: "turn_state" },
  ];
}

const CHAT_RESULT_BODY = JSON.stringify({
  id: "gen-1",
  model: "m",
  object: "chat.completion",
  created: 1,
  system_fingerprint: "fp-test",
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/** The JSON body the real SDK would put on the wire for `chatRequest`. */
export async function captureWireBody(chatRequest: ChatRequest): Promise<string> {
  let captured: string | null = null;
  const httpClient = new HTTPClient({
    fetcher: async (input) => {
      if (!(input instanceof Request)) throw new Error("expected a Request");
      captured = await input.text();
      return new Response(CHAT_RESULT_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });
  const client = new OpenRouter({ apiKey: "sk-or-test", httpClient });
  await client.chat.send({ chatRequest: { ...chatRequest, stream: false } });
  if (captured === null) throw new Error("fetcher was never invoked");
  return captured;
}

/** The wire `messages` array of a captured body. */
export function wireMessages(body: string): Array<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(body);
  if (typeof parsed !== "object" || parsed === null) throw new Error("body is not an object");
  const messages: unknown = Reflect.get(parsed, "messages");
  if (!Array.isArray(messages)) throw new Error("body has no messages");
  return messages.filter(
    (m): m is Record<string, unknown> => typeof m === "object" && m !== null,
  );
}

/** Raw snake_case SSE `data:` payloads, streamed through the real SDK parser. */
export async function streamThroughSdk(
  sseChunks: readonly object[],
  captureReasoningReplay: boolean,
): Promise<StreamChunk[]> {
  const body = sseChunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
  const httpClient = new HTTPClient({
    fetcher: async () =>
      new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
  });
  const client = new OpenRouter({ apiKey: "sk-or-test", httpClient });
  const stream = asEventStream(
    await client.chat.send({
      chatRequest: { model: "m", messages: [{ role: "user", content: "hi" }], stream: true },
    }),
    "test stream",
  );
  const out: StreamChunk[] = [];
  for await (const chunk of consumeOpenRouterStream(stream, captureReasoningReplay)) out.push(chunk);
  return out;
}

/** A raw snake_case buffered completion, parsed by the real SDK. */
export async function bufferedThroughSdk(rawBody: object): Promise<ChatResult> {
  const httpClient = new HTTPClient({
    fetcher: async () =>
      new Response(JSON.stringify(rawBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const client = new OpenRouter({ apiKey: "sk-or-test", httpClient });
  return asChatResult(
    await client.chat.send({
      chatRequest: { model: "m", messages: [{ role: "user", content: "hi" }], stream: false },
    }),
    "test completion",
  );
}

/** One raw SSE chunk in OpenRouter's snake_case wire shape. */
export function sseChunk(delta: object, finishReason: string | null = null): object {
  return {
    id: "gen-r7",
    model: "m",
    object: "chat.completion.chunk",
    created: 1,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
