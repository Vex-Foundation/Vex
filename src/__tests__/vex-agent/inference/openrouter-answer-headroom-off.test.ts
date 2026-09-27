/**
 * R-2 switch-off contract: with `ANSWER_HEADROOM_ENABLED = false` the wire
 * request is byte-identical to the pre-R-2 request, even at the highest effort
 * with full catalog metadata present.
 *
 * The constant is module-level, so it is replaced through `vi.mock`; every
 * other export of the module stays real.
 */

import { describe, it, expect, vi } from "vitest";

import { ChatRequest$outboundSchema } from "@openrouter/sdk/models/chatrequest.js";

vi.mock("../../../vex-agent/inference/openrouter/answer-headroom.js", async (importOriginal) => {
  const actual = await importOriginal<
    typeof import("../../../vex-agent/inference/openrouter/answer-headroom.js")
  >();
  return { ...actual, ANSWER_HEADROOM_ENABLED: false };
});

import { buildOpenRouterParams } from "../../../vex-agent/inference/openrouter/params.js";
import type {
  InferenceConfig,
  ProviderMessage,
  ReasoningEffort,
  ToolDefinition,
} from "../../../vex-agent/inference/types.js";

const CONFIG: InferenceConfig = {
  provider: "openrouter",
  model: "openai/gpt-5",
  contextLimit: 256_000,
  maxOutputTokens: 16_384,
  inputPricePerM: 3,
  outputPricePerM: 15,
  priceCurrency: "USD",
  cachePricePerM: null,
  cacheWritePricePerM: null,
  reasoningPricePerM: null,
  supportsReasoningEffort: true,
  modelMaxCompletionTokens: 64_000,
};

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
];

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "wallet_balance",
      description: "Read a wallet balance",
      parameters: { type: "object", properties: {}, additionalProperties: false },
    },
  },
];

function encoded(params: ReturnType<typeof buildOpenRouterParams>): string {
  const parsed = ChatRequest$outboundSchema.safeParse(params);
  if (!parsed.success) throw new Error("SDK outbound schema rejected the params");
  return JSON.stringify(parsed.data);
}

describe("answer headroom switched off", () => {
  it("sends the configured max_tokens and the pre-R-2 body at every effort", () => {
    const efforts: ReadonlyArray<ReasoningEffort> = [
      "none",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ];
    for (const reasoningEffort of efforts) {
      const params = buildOpenRouterParams(MESSAGES, TOOLS, { ...CONFIG, reasoningEffort }, true);
      expect(params.maxTokens).toBe(16_384);

      // Pre-R-2 shape: the same request with no catalog max at all (the
      // metadata R-2 added) — the only input the policy reads to raise.
      const { modelMaxCompletionTokens: _unused, ...legacyConfig } = CONFIG;
      const legacy = buildOpenRouterParams(
        MESSAGES,
        TOOLS,
        { ...legacyConfig, reasoningEffort },
        true,
      );
      expect(encoded(params)).toBe(encoded(legacy));
    }
  });

  it("pins the exact wire body at xhigh", () => {
    const params = buildOpenRouterParams(
      MESSAGES,
      [],
      { ...CONFIG, reasoningEffort: "xhigh" },
      false,
    );
    expect(encoded(params)).toBe(
      JSON.stringify({
        max_tokens: 16_384,
        messages: [
          { content: "SYS", role: "system" },
          { content: "hello", role: "user" },
        ],
        model: "openai/gpt-5",
        reasoning: { effort: "xhigh" },
        stream: false,
      }),
    );
  });
});
