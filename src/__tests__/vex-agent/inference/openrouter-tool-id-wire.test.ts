/**
 * WIRE-level proof that a poisoned tape cannot reach OpenRouter.
 *
 * The production failure was a provider 400 — "Duplicate item found with id
 * fc_2" — so the assertion that matters is on the JSON body the SDK actually
 * emits, not on our intermediate objects. The SDK (1.1.13) forwards duplicate
 * and blank tool-call ids unchanged, so nothing downstream of us fixes this.
 *
 * Uniqueness is defined over ASSISTANT CALL DECLARATIONS (`tool_calls[].id`).
 * A `tool` row legitimately repeats the id of the call it answers — that is
 * the pairing contract, not a duplicate.
 */

import { describe, it, expect } from "vitest";

import { OpenRouter, HTTPClient } from "@openrouter/sdk";
import { buildOpenRouterParams } from "@vex-agent/inference/openrouter/params.js";
import { mapMessages } from "@vex-agent/inference/openrouter/mappers.js";
import type {
  InferenceConfig,
  ProviderMessage,
} from "@vex-agent/inference/types.js";

const CONFIG: InferenceConfig = {
  provider: "openrouter",
  model: "deepseek/deepseek-v4-flash",
  contextLimit: 128_000,
  maxOutputTokens: 4096,
  inputPricePerM: 3,
  outputPricePerM: 15,
  priceCurrency: "USD",
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
  supportsReasoningEffort: false,
};

const CHAT_RESULT_BODY = JSON.stringify({
  id: "gen-1",
  model: CONFIG.model,
  object: "chat.completion",
  created: 1,
  system_fingerprint: "fp-test",
  choices: [
    { index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

interface WireMessage {
  readonly role: string;
  readonly tool_call_id?: string;
  readonly tool_calls?: readonly { readonly id?: string }[];
}

async function captureWireMessages(
  messages: ProviderMessage[],
): Promise<WireMessage[]> {
  let captured: WireMessage[] | null = null;

  const httpClient = new HTTPClient({
    fetcher: async (input) => {
      const request = input as Request;
      const body = JSON.parse(await request.text()) as {
        messages: WireMessage[];
      };
      captured = body.messages;
      return new Response(CHAT_RESULT_BODY, {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  });

  const params = buildOpenRouterParams(messages, [], CONFIG, false);
  const client = new OpenRouter({ apiKey: "sk-or-test", httpClient });
  await client.chat.send({ chatRequest: { ...params, stream: false } });

  if (captured === null) throw new Error("fetcher was never invoked");
  return captured;
}

function declaredCallIds(wire: readonly WireMessage[]): string[] {
  return wire.flatMap((m) => (m.tool_calls ?? []).map((c) => c.id ?? ""));
}

describe("OpenRouter wire request — tool-call id integrity", () => {
  it("emits no duplicate declared call id for a tape that repeats one", async () => {
    const poisoned: ProviderMessage[] = [
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "fc_2", command: "noop", args: {} }],
      },
      { role: "tool", content: "A", toolCallId: "fc_2" },
      { role: "user", content: "again" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "fc_2", command: "noop", args: {} }],
      },
      { role: "tool", content: "B", toolCallId: "fc_2" },
    ];

    const wire = await captureWireMessages(poisoned);
    const ids = declaredCallIds(wire);

    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    // Every tool row still answers the call immediately above it.
    expect(wire[2]?.tool_call_id).toBe(ids[0]);
    expect(wire[5]?.tool_call_id).toBe(ids[1]);
  });

  it("emits no duplicate declared call id for SAME-BLOCK duplicates", async () => {
    const poisoned: ProviderMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "fc_2", command: "noop", args: {} },
          { id: "fc_2", command: "noop", args: {} },
        ],
      },
      { role: "tool", content: "A", toolCallId: "fc_2" },
      { role: "tool", content: "B", toolCallId: "fc_2" },
    ];

    const wire = await captureWireMessages(poisoned);
    const ids = declaredCallIds(wire);

    expect(new Set(ids).size).toBe(2);
    expect(wire[1]?.tool_call_id).toBe(ids[0]);
    expect(wire[2]?.tool_call_id).toBe(ids[1]);
    // No placeholder was needed — both calls were answered.
    expect(wire).toHaveLength(3);
  });

  it("emits no blank id, and keeps the blank tool row a TOOL row", async () => {
    const poisoned: ProviderMessage[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "", command: "noop", args: {} }],
      },
      { role: "tool", content: "result", toolCallId: "" },
    ];

    const wire = await captureWireMessages(poisoned);
    const ids = declaredCallIds(wire);

    expect(ids.every((id) => id.length > 0)).toBe(true);
    // Without normalization the falsy `toolCallId` demoted this to `user`.
    expect(wire[1]?.role).toBe("tool");
    expect(wire[1]?.tool_call_id).toBe(ids[0]);
  });

  it("leaves a clean tape byte-identical through mapMessages", async () => {
    const clean: ProviderMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [{ id: "c1", command: "noop", args: { a: 1 } }],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ];
    const before = JSON.stringify(clean);
    const mapped = mapMessages(clean);

    expect(JSON.stringify(clean)).toBe(before);
    expect(mapped).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "thinking",
        toolCalls: [
          {
            id: "c1",
            type: "function",
            function: { name: "noop", arguments: '{"a":1}' },
          },
        ],
      },
      { role: "tool", content: "ok", toolCallId: "c1" },
    ]);
  });
});
