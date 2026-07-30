/**
 * PROOF that `measureOpenRouterRequestBodyBytes` bounds the real request.
 *
 * The measurement is checked against the body the SDK's own send path builds,
 * reconstructed here through a DIFFERENT route than production uses: through
 * `SendChatCompletionRequestRequest$outboundSchema` + `encodeJSON`, exactly as
 * `@openrouter/sdk/esm/funcs/chatSend.js` does (lines 19 and 24). Production
 * goes through `ChatRequest$outboundSchema` directly. Two independent paths to
 * the same bytes is what makes this a proof rather than a tautology — and an
 * SDK upgrade that changes the wire shape breaks it loudly.
 */

import { describe, it, expect } from "vitest";
import { encodeJSON } from "@openrouter/sdk/lib/encodings.js";
import { SendChatCompletionRequestRequest$outboundSchema } from "@openrouter/sdk/models/operations/sendchatcompletionrequest.js";
import { MetadataLevel } from "@openrouter/sdk/models/metadatalevel.js";
import type {
  InferenceConfig,
  ProviderMessage,
  ToolDefinition,
} from "../../../../vex-agent/inference/types.js";
import { buildOpenRouterParams } from "../../../../vex-agent/inference/openrouter/params.js";
import { measureOpenRouterRequestBodyBytes } from "../../../../vex-agent/inference/openrouter/request-bytes.js";

/**
 * Config exercising every optional request field Gate-0 §22 names: routing
 * (endpoint pin), reasoning effort, max output, cache pricing.
 */
const RICH_CONFIG: InferenceConfig = {
  provider: "openrouter",
  // Explicit-cache family + cache pricing ⇒ breakpoints are applied, which
  // ADDS `cache_control` objects to the wire messages.
  model: "anthropic/claude-sonnet-4",
  contextLimit: 200_000,
  endpointTag: "anthropic/us-east",
  temperature: 0.4,
  maxOutputTokens: 8192,
  inputPricePerM: 3,
  outputPricePerM: 15,
  priceCurrency: "USD",
  cachePricePerM: 0.3,
  cacheWritePricePerM: 3.75,
  reasoningPricePerM: null,
  supportsReasoningEffort: true,
  reasoningEffort: "high",
};

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "You are Vex. ".repeat(40), cacheHint: "static_prefix" },
  { role: "system", content: "[Previous conversation summary]\nEarlier: ünïcøde ✅", cacheHint: "summary" },
  { role: "user", content: "swap 1 SOL for USDC" },
  {
    role: "assistant",
    content: "quoting",
    toolCalls: [{ id: "call-1", command: "get_quote", args: { amount: "1", from: "SOL" } }],
  },
  { role: "tool", content: "180.25 USDC", toolCallId: "call-1", cacheHint: "history_tail" },
  { role: "system", content: "[Turn state] context 91%", cacheHint: "turn_state" },
];

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "execute_swap",
      description: "Execute a swap on a supported DEX. Irreversible; moves real funds.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "source token mint" },
          to: { type: "string", description: "destination token mint" },
          amount: { type: "string", description: "raw amount in base units" },
        },
        required: ["from", "to", "amount"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_balance",
      description: "Read a wallet balance.",
      parameters: { type: "object", properties: { mint: { type: "string" } } },
    },
  },
];

const CONTEXT = { sessionId: "session-1", missionRunId: null };

/** The body the SDK actually PUTs on the wire, via chatSend's own route. */
function sdkSendPathBodyBytes(stream: boolean): number {
  const params = buildOpenRouterParams(
    MESSAGES,
    TOOLS,
    RICH_CONFIG,
    stream,
    undefined,
    CONTEXT,
  );
  const payload = SendChatCompletionRequestRequest$outboundSchema.parse({
    xOpenRouterMetadata: MetadataLevel.Enabled,
    chatRequest: { ...params, stream },
  });
  const body = encodeJSON("body", payload.ChatRequest, { explode: true });
  return Buffer.byteLength(String(body), "utf8");
}

describe("measureOpenRouterRequestBodyBytes", () => {
  it("bounds the real serialized body for a request with tools, reasoning and routing", () => {
    const measured = measureOpenRouterRequestBodyBytes({
      messages: MESSAGES,
      tools: TOOLS,
      config: RICH_CONFIG,
      context: CONTEXT,
    });

    expect(measured).not.toBeNull();
    // Superset over BOTH conversational send shapes — streaming and buffered.
    expect(measured!).toBeGreaterThanOrEqual(sdkSendPathBodyBytes(true));
    expect(measured!).toBeGreaterThanOrEqual(sdkSendPathBodyBytes(false));
  });

  it("the bound is tight, not inflated — within a byte of the real body", () => {
    // Guards the other direction: a measurement that over-counts wildly would
    // pass the superset assertion while forcing compaction far too early.
    const measured = measureOpenRouterRequestBodyBytes({
      messages: MESSAGES,
      tools: TOOLS,
      config: RICH_CONFIG,
      context: CONTEXT,
    })!;

    expect(measured - sdkSendPathBodyBytes(false)).toBe(0);
    expect(measured - sdkSendPathBodyBytes(true)).toBe(1);
  });

  it("counts the fields a naive {messages, tools} estimate would miss", () => {
    // Gate-0 §22: model, max output, routing, reasoning, tool choice,
    // normalized schemas and sticky session id are all part of the request.
    const withRouting = measureOpenRouterRequestBodyBytes({
      messages: MESSAGES,
      tools: TOOLS,
      config: RICH_CONFIG,
      context: CONTEXT,
    })!;

    const noRoutingNoReasoning = measureOpenRouterRequestBodyBytes({
      messages: MESSAGES,
      tools: TOOLS,
      config: {
        ...RICH_CONFIG,
        endpointTag: undefined,
        supportsReasoningEffort: false,
        reasoningEffort: undefined,
      },
      context: undefined,
    })!;

    expect(withRouting).toBeGreaterThan(noRoutingNoReasoning);
  });

  it("tool definitions are counted — dropping them shrinks the measurement", () => {
    const withTools = measureOpenRouterRequestBodyBytes({
      messages: MESSAGES,
      tools: TOOLS,
      config: RICH_CONFIG,
      context: CONTEXT,
    })!;
    const withoutTools = measureOpenRouterRequestBodyBytes({
      messages: MESSAGES,
      tools: [],
      config: RICH_CONFIG,
      context: CONTEXT,
    })!;

    // At barrier the catalog is the largest single non-history block, so this
    // difference is the whole reason tool definitions are not optional here.
    expect(withTools - withoutTools).toBeGreaterThan(200);
  });

  it("measures UTF-8 bytes, not UTF-16 code units (multi-byte content counts fully)", () => {
    const ascii: ProviderMessage[] = [{ role: "user", content: "aaaa" }];
    const emoji: ProviderMessage[] = [{ role: "user", content: "🙂🙂" }];

    const asciiBytes = measureOpenRouterRequestBodyBytes({
      messages: ascii, tools: [], config: RICH_CONFIG, context: CONTEXT,
    })!;
    const emojiBytes = measureOpenRouterRequestBodyBytes({
      messages: emoji, tools: [], config: RICH_CONFIG, context: CONTEXT,
    })!;

    // Two emoji are 4 UTF-16 code units but 8 UTF-8 bytes; a `.length`-based
    // measurement would report them as equal to the 4-char ASCII string.
    expect(emojiBytes).toBeGreaterThan(asciiBytes);
  });
});
