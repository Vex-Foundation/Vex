import { describe, it, expect } from "vitest";
import type {
  InferenceConfig,
  ProviderMessage,
  ToolDefinition,
} from "../../../../vex-agent/inference/types.js";
import {
  BYTES_PER_TOKEN_LOWER_BOUND,
  checkPreInferenceCeiling,
  measureInferenceEnvelopeBytes,
} from "../../../../vex-agent/engine/core/inference-envelope-bytes.js";

const CONFIG: InferenceConfig = {
  provider: "openrouter",
  model: "anthropic/claude-sonnet-4",
  contextLimit: 200_000,
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
  { role: "system", content: "prefix", cacheHint: "static_prefix" },
  { role: "user", content: "hello" },
  { role: "system", content: "turn state", cacheHint: "turn_state" },
];

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "execute_swap",
      description: "Moves real funds.",
      parameters: { type: "object", properties: { amount: { type: "string" } } },
    },
  },
];

describe("measureInferenceEnvelopeBytes", () => {
  it("measures the real OpenRouter request body", () => {
    const result = measureInferenceEnvelopeBytes({
      providerMessages: MESSAGES,
      tools: TOOLS,
      config: CONFIG,
    });

    expect(result.kind).toBe("measured");
    expect(result.kind === "measured" && result.bytes).toBeGreaterThan(0);
  });

  it("includes tool definitions in the count", () => {
    const withTools = measureInferenceEnvelopeBytes({
      providerMessages: MESSAGES, tools: TOOLS, config: CONFIG,
    });
    const withoutTools = measureInferenceEnvelopeBytes({
      providerMessages: MESSAGES, tools: [], config: CONFIG,
    });

    expect(withTools.kind).toBe("measured");
    expect(withoutTools.kind).toBe("measured");
    expect(withTools.kind === "measured" ? withTools.bytes : 0).toBeGreaterThan(
      withoutTools.kind === "measured" ? withoutTools.bytes : 0,
    );
  });

  it("an unknown provider is UNMEASURABLE — never silently estimated", () => {
    // Fail-closed: the caller must fall back to the ordinary barrier rather
    // than bypass it on a wire size nobody has measured.
    const result = measureInferenceEnvelopeBytes({
      providerMessages: MESSAGES,
      tools: TOOLS,
      config: { ...CONFIG, provider: "some-future-provider" },
    });

    expect(result).toEqual({ kind: "unmeasurable", provider: "some-future-provider" });
  });
});

describe("checkPreInferenceCeiling", () => {
  it("BYTES_PER_TOKEN_LOWER_BOUND stays at the safe 1 until a provider measurement justifies more", () => {
    // Raising this weakens the ceiling. C8 requires a cited provider
    // measurement before it moves; this test is the tripwire.
    expect(BYTES_PER_TOKEN_LOWER_BOUND).toBe(1);
  });

  it("well under the limit ⇒ ok, with the projection reported", () => {
    expect(checkPreInferenceCeiling({ envelopeBytes: 1_000, contextLimit: 200_000 })).toEqual({
      kind: "ok",
      projectedTokensLowerBound: 1_000,
    });
  });

  it("breach boundary is EXACTLY at the limit, not one past it", () => {
    expect(checkPreInferenceCeiling({ envelopeBytes: 199_999, contextLimit: 200_000 }).kind).toBe("ok");
    expect(checkPreInferenceCeiling({ envelopeBytes: 200_000, contextLimit: 200_000 }).kind).toBe("breach");
    expect(checkPreInferenceCeiling({ envelopeBytes: 200_001, contextLimit: 200_000 }).kind).toBe("breach");
  });

  it("NaN contextLimit is a BREACH, not an ok (the fail-open trap)", () => {
    // A bare `projected >= NaN` is false, which would report "ok" and disable
    // the ceiling entirely. This is the case that guard exists for.
    expect(checkPreInferenceCeiling({ envelopeBytes: 10, contextLimit: Number.NaN }).kind).toBe("breach");
  });

  it("zero, negative and infinite context limits are breaches", () => {
    expect(checkPreInferenceCeiling({ envelopeBytes: 10, contextLimit: 0 }).kind).toBe("breach");
    expect(checkPreInferenceCeiling({ envelopeBytes: 10, contextLimit: -5 }).kind).toBe("breach");
    expect(
      checkPreInferenceCeiling({ envelopeBytes: 10, contextLimit: Number.POSITIVE_INFINITY }).kind,
    ).toBe("breach");
  });

  it("NaN or negative envelope bytes are breaches", () => {
    expect(checkPreInferenceCeiling({ envelopeBytes: Number.NaN, contextLimit: 200_000 }).kind).toBe("breach");
    expect(checkPreInferenceCeiling({ envelopeBytes: -1, contextLimit: 200_000 }).kind).toBe("breach");
  });

  it("a measured real envelope of a small request is far below a normal limit", () => {
    const measured = measureInferenceEnvelopeBytes({
      providerMessages: MESSAGES, tools: TOOLS, config: CONFIG,
    });
    expect(measured.kind).toBe("measured");
    const bytes = measured.kind === "measured" ? measured.bytes : 0;

    expect(checkPreInferenceCeiling({ envelopeBytes: bytes, contextLimit: CONFIG.contextLimit }).kind).toBe("ok");
    // …and the same envelope breaches a tiny window, proving the two pieces
    // compose the way the turn loop will use them.
    expect(checkPreInferenceCeiling({ envelopeBytes: bytes, contextLimit: 10 }).kind).toBe("breach");
  });
});
