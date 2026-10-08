/**
 * R-2 - model-aware answer headroom.
 *
 * Reasoning and the visible answer share `max_tokens` on OpenRouter, so when
 * an effort is sent the request's `max_tokens` is raised to a per-effort floor,
 * capped by the model's max completion tokens and the context room left after
 * the prompt. Pinned here:
 *
 *   - the floor per effort, and no raise for `none` / no effort sent;
 *   - the model-max cap and the context-window cap;
 *   - a higher configured AGENT_MAX_OUTPUT_TOKENS is never lowered;
 *   - pinned endpoint / unknown model max → no raise;
 *   - on the WIRE, `reasoning` still carries `effort` only (never
 *     `reasoning.max_tokens` alongside it);
 *   - the catalog's `top_provider.max_completion_tokens` reaches the config
 *     through the real SDK deserialisation.
 *
 * The switch-off path (byte-identical to pre-R-2) lives in
 * `openrouter-answer-headroom-off.test.ts`, which has to mock the constant.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import { OpenRouter, HTTPClient } from "@openrouter/sdk";
import { ChatRequest$outboundSchema } from "@openrouter/sdk/models/chatrequest.js";

import {
  ANSWER_HEADROOM_ENABLED,
  ANSWER_HEADROOM_FLOORS,
  parseModelMaxCompletionTokens,
  resolveAnswerHeadroomMaxTokens,
  type AnswerHeadroomInput,
} from "../../../vex-agent/inference/openrouter/answer-headroom.js";
import { buildOpenRouterParams } from "../../../vex-agent/inference/openrouter/params.js";
import { fetchModelInferenceConfig } from "../../../vex-agent/inference/openrouter/model-catalog.js";
import type {
  InferenceConfig,
  ProviderMessage,
  ReasoningEffort,
} from "../../../vex-agent/inference/types.js";

function makeInput(overrides: Partial<AnswerHeadroomInput> = {}): AnswerHeadroomInput {
  return {
    configuredMaxTokens: 16_384,
    model: "openai/gpt-5",
    sentEffort: "high",
    modelMaxCompletionTokens: 128_000,
    contextLimit: 1_000_000,
    endpointPinned: false,
    promptTokensUpperBound: () => 1_000,
    ...overrides,
  };
}

function makeConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
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
    ...overrides,
  };
}

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "hello" },
];

/** Encode exactly as the SDK's send path does before `encodeJSON`. */
function wireBody(params: ReturnType<typeof buildOpenRouterParams>): Record<string, unknown> {
  const parsed = ChatRequest$outboundSchema.safeParse(params);
  if (!parsed.success) throw new Error("SDK outbound schema rejected the params");
  const body: unknown = JSON.parse(JSON.stringify(parsed.data));
  if (typeof body !== "object" || body === null) throw new Error("body is not an object");
  return Object.fromEntries(Object.entries(body));
}

describe("resolveAnswerHeadroomMaxTokens - policy", () => {
  it("ships switched on", () => {
    expect(ANSWER_HEADROOM_ENABLED).toBe(true);
  });

  it("raises to the per-effort floor", () => {
    const expected: ReadonlyArray<readonly [ReasoningEffort, number]> = [
      ["minimal", 16_384],
      ["low", 16_384],
      ["medium", 24_576],
      ["high", 32_768],
      ["xhigh", 65_536],
      ["max", 65_536],
    ];
    for (const [effort, floor] of expected) {
      expect(ANSWER_HEADROOM_FLOORS[effort]).toBe(floor);
      const decision = resolveAnswerHeadroomMaxTokens(
        makeInput({ configuredMaxTokens: 4_096, sentEffort: effort }),
      );
      expect(decision).toEqual({ maxTokens: floor, reason: "raised_to_floor" });
    }
  });

  it("does not raise when no effort is sent, or the effort is none", () => {
    for (const sentEffort of [undefined, "none"] as const) {
      const decision = resolveAnswerHeadroomMaxTokens(makeInput({ sentEffort }));
      expect(decision).toEqual({ maxTokens: 16_384, reason: "no_effort" });
    }
  });

  it("leaves the default alone at low effort (floor equals the default)", () => {
    const decision = resolveAnswerHeadroomMaxTokens(makeInput({ sentEffort: "low" }));
    expect(decision).toEqual({ maxTokens: 16_384, reason: "configured_sufficient" });
  });

  it("caps at the model's advertised max completion tokens", () => {
    const decision = resolveAnswerHeadroomMaxTokens(
      makeInput({ sentEffort: "xhigh", modelMaxCompletionTokens: 32_000 }),
    );
    expect(decision).toEqual({ maxTokens: 32_000, reason: "capped_by_model_max" });
  });

  it("caps so prompt + max_tokens stays inside the context limit", () => {
    const decision = resolveAnswerHeadroomMaxTokens(
      makeInput({
        sentEffort: "xhigh",
        contextLimit: 100_000,
        promptTokensUpperBound: () => 60_000,
      }),
    );
    expect(decision).toEqual({ maxTokens: 40_000, reason: "capped_by_context" });
  });

  it("falls back to the configured value when the context room is below it", () => {
    const decision = resolveAnswerHeadroomMaxTokens(
      makeInput({ contextLimit: 100_000, promptTokensUpperBound: () => 95_000 }),
    );
    expect(decision).toEqual({ maxTokens: 16_384, reason: "configured_sufficient" });
  });

  it("never lowers a higher configured AGENT_MAX_OUTPUT_TOKENS", () => {
    const decision = resolveAnswerHeadroomMaxTokens(
      makeInput({ configuredMaxTokens: 100_000, sentEffort: "max" }),
    );
    expect(decision).toEqual({ maxTokens: 100_000, reason: "configured_sufficient" });
  });

  it("does not raise when an endpoint is pinned or the model max is unknown", () => {
    expect(resolveAnswerHeadroomMaxTokens(makeInput({ endpointPinned: true }))).toEqual({
      maxTokens: 16_384,
      reason: "endpoint_pinned",
    });
    expect(
      resolveAnswerHeadroomMaxTokens(makeInput({ modelMaxCompletionTokens: undefined })),
    ).toEqual({ maxTokens: 16_384, reason: "model_max_unknown" });
  });

  it("does not raise for families whose thinking budget scales with max_tokens", () => {
    let measured = 0;
    const decision = resolveAnswerHeadroomMaxTokens(
      makeInput({
        model: "anthropic/claude-sonnet-4.5",
        sentEffort: "xhigh",
        promptTokensUpperBound: () => {
          measured += 1;
          return 1_000;
        },
      }),
    );
    expect(decision).toEqual({ maxTokens: 16_384, reason: "budget_scales_with_max_tokens" });
    expect(measured).toBe(0);
  });

  it("returns the configured value verbatim when switched off", () => {
    expect(resolveAnswerHeadroomMaxTokens(makeInput({ sentEffort: "max" }), false)).toEqual({
      maxTokens: 16_384,
      reason: "disabled",
    });
  });

  it("only measures the prompt when a raise is actually possible", () => {
    let measured = 0;
    const promptTokensUpperBound = (): number => {
      measured += 1;
      return 1_000;
    };
    resolveAnswerHeadroomMaxTokens(makeInput({ sentEffort: undefined, promptTokensUpperBound }));
    resolveAnswerHeadroomMaxTokens(makeInput({ sentEffort: "low", promptTokensUpperBound }));
    resolveAnswerHeadroomMaxTokens(makeInput({ endpointPinned: true, promptTokensUpperBound }));
    expect(measured).toBe(0);
    resolveAnswerHeadroomMaxTokens(makeInput({ promptTokensUpperBound }));
    expect(measured).toBe(1);
  });

  it("rejects an untrusted catalog max that is not a positive integer", () => {
    expect(parseModelMaxCompletionTokens(64_000)).toBe(64_000);
    for (const raw of [undefined, null, 0, -1, 1.5, "64000", Number.NaN]) {
      expect(parseModelMaxCompletionTokens(raw)).toBeUndefined();
    }
  });
});

describe("buildOpenRouterParams - answer headroom on the request", () => {
  it("raises max_tokens at high effort and keeps reasoning to effort only", () => {
    const params = buildOpenRouterParams(MESSAGES, [], makeConfig({ reasoningEffort: "high" }), true);
    expect(params.maxTokens).toBe(32_768);

    const body = wireBody(params);
    expect(body["max_tokens"]).toBe(32_768);
    expect(body["reasoning"]).toEqual({ effort: "high" });
  });

  it("caps at the model max on the request (64k ceiling at xhigh)", () => {
    const params = buildOpenRouterParams(MESSAGES, [], makeConfig({ reasoningEffort: "xhigh" }), true);
    expect(params.maxTokens).toBe(64_000);
  });

  it("caps by the context room left after the measured request body", () => {
    const bigMessages: ProviderMessage[] = [
      { role: "system", content: "S".repeat(40_000) },
      { role: "user", content: "hello" },
    ];
    const params = buildOpenRouterParams(
      bigMessages,
      [],
      makeConfig({ reasoningEffort: "xhigh", contextLimit: 80_000 }),
      false,
    );
    const maxTokens = params.maxTokens ?? 0;
    // Room is 80k minus a body of just over 40k bytes: raised, but below the
    // 64k model max, and prompt + max_tokens stays inside the limit.
    expect(maxTokens).toBeGreaterThan(16_384);
    expect(maxTokens).toBeLessThan(40_000);
    // The measurement ran with `maxTokens: 16384`; the raised value has the
    // same digit count, so the body size is unchanged by the raise.
    const bodyBytes = Buffer.byteLength(JSON.stringify(params), "utf8");
    expect(bodyBytes + maxTokens).toBe(80_000);
  });

  it("leaves max_tokens and the whole body unchanged when no effort is sent", () => {
    const withMeta = buildOpenRouterParams(MESSAGES, [], makeConfig(), true);
    const withoutMeta = buildOpenRouterParams(
      MESSAGES,
      [],
      makeConfig({ modelMaxCompletionTokens: undefined }),
      true,
    );
    expect(withMeta.maxTokens).toBe(16_384);
    expect(JSON.stringify(wireBody(withMeta))).toBe(JSON.stringify(wireBody(withoutMeta)));
  });

  it("does not raise when the model does not accept an effort (effort dropped)", () => {
    const params = buildOpenRouterParams(
      MESSAGES,
      [],
      makeConfig({ reasoningEffort: "max", supportsReasoningEffort: false }),
      true,
    );
    expect(params.maxTokens).toBe(16_384);
    expect("reasoning" in params).toBe(false);
  });

  it("leaves an Anthropic request at the configured max_tokens (budget = max_tokens x ratio)", () => {
    const params = buildOpenRouterParams(
      MESSAGES,
      [],
      makeConfig({ model: "anthropic/claude-sonnet-4.5", reasoningEffort: "high" }),
      true,
    );
    expect(params.maxTokens).toBe(16_384);
    expect(wireBody(params)["reasoning"]).toEqual({ effort: "high" });
  });

  it("keeps a higher configured value on the request", () => {
    const params = buildOpenRouterParams(
      MESSAGES,
      [],
      makeConfig({ reasoningEffort: "xhigh", maxOutputTokens: 100_000 }),
      true,
    );
    expect(params.maxTokens).toBe(100_000);
  });
});

describe("fetchModelInferenceConfig - model max completion tokens", () => {
  const FIXTURE_BODY = readFileSync(
    fileURLToPath(new URL("./fixtures/openrouter-models/models-subset.json", import.meta.url)),
    "utf8",
  );

  function fixtureClient(): OpenRouter {
    const httpClient = new HTTPClient({
      fetcher: async () =>
        new Response(FIXTURE_BODY, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    return new OpenRouter({ apiKey: "", httpClient });
  }

  it("carries top_provider.max_completion_tokens from the recorded catalogue", async () => {
    const result = await fetchModelInferenceConfig(fixtureClient(), {
      providerId: "openrouter",
      model: "anthropic/claude-sonnet-4.5",
      contextLimit: 256_000,
      temperature: undefined,
      maxOutputTokens: 16_384,
      endpointTag: undefined,
    });
    expect(result.kind).toBe("success");
    if (result.kind !== "success") return;
    expect(result.config.modelMaxCompletionTokens).toBe(64_000);
  });
});
