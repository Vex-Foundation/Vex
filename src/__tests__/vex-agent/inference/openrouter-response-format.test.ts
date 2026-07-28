/**
 * F31 Layer B — API-level output-format enforcement wiring.
 *
 * Two layers under pin:
 *   1. `buildOpenRouterParams` spreads a `responseFormat` ONLY when one is
 *      passed; with no arg the request has NO `responseFormat` key, so the four
 *      non-judge `chatCompletionSimple` callers (chunker, regime-worker,
 *      entity-extraction, reconcile-judge) stay byte-identical on the wire.
 *   2. `OpenRouterProvider.chatCompletionSimple` composes `provider.requireParameters`
 *      AROUND `buildOpenRouterParams` (the param unit test can't see that — it
 *      lives at the send call), so a mocked `chat.send` proves that a request WITH
 *      a responseFormat carries BOTH the format AND `provider.requireParameters:true`,
 *      and a request WITHOUT one carries NEITHER.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mocked SDK client (drives the chat.send composition test) ────────────────
const sendMock = vi.fn();

vi.mock("@openrouter/sdk", () => ({
  OpenRouter: class {
    readonly models = { list: vi.fn() };
    readonly chat = { send: sendMock };
    readonly credits = {};
    readonly apiKeys = {};
    constructor(_opts: unknown) {}
  },
}));

const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
  child: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({
  default: loggerMock,
  logger: loggerMock,
  createChildLogger: () => loggerMock,
}));

const { buildOpenRouterParams } = await import("../../../vex-agent/inference/openrouter/params.js");
const { buildJudgeResponseFormat } = await import(
  "../../../vex-agent/inference/openrouter/judge-format.js"
);
const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { judgeVerdictJsonSchema } = await import(
  "../../../vex-agent/memory/manager/judge-schema.js"
);

import type {
  InferenceConfig,
  ProviderMessage,
} from "../../../vex-agent/inference/types.js";

function makeConfig(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
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
    ...overrides,
  };
}

const MESSAGES: ProviderMessage[] = [
  { role: "system", content: "SYS" },
  { role: "user", content: "candidate" },
];

const RESPONSE_FORMAT = buildJudgeResponseFormat(judgeVerdictJsonSchema);

describe("buildOpenRouterParams — responseFormat spread (F31 Layer B)", () => {
  it("omits the responseFormat key entirely when none is passed (4 callers byte-identical)", () => {
    const params = buildOpenRouterParams(MESSAGES, [], makeConfig(), false);
    expect("responseFormat" in params).toBe(false);
    // W2 moved `provider` composition INTO this layer, so the key is absent
    // here for a positive reason rather than by construction: no tools, no
    // responseFormat and no endpoint pin ⇒ no lever ⇒ no `provider` key.
    expect("provider" in params).toBe(false);
  });

  it("includes the responseFormat when one is passed", () => {
    const params = buildOpenRouterParams(MESSAGES, [], makeConfig(), false, RESPONSE_FORMAT);
    expect(params.responseFormat).toBe(RESPONSE_FORMAT);
  });
});

describe("buildJudgeResponseFormat — shape", () => {
  it("wraps the JSON schema as a strict json_schema format named judge_verdict", () => {
    expect(RESPONSE_FORMAT).toEqual({
      type: "json_schema",
      jsonSchema: {
        name: "judge_verdict",
        strict: true,
        description: "Memory-promotion judge verdict",
        schema: judgeVerdictJsonSchema,
      },
    });
  });
});

describe("OpenRouterProvider.chatCompletionSimple — provider routing composition (F31 Layer B)", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
    sendMock.mockResolvedValue({
      choices: [{ message: { content: "{}" } }],
      usage: undefined,
    });
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("AGENT_") || key.startsWith("OPENROUTER_")) {
        delete process.env[key];
      }
    }
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    process.env.AGENT_MODEL = "deepseek/deepseek-v4-flash";
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("WITH a responseFormat sends both the format AND provider.requireParameters:true", async () => {
    const provider = new OpenRouterProvider();
    await provider.chatCompletionSimple(MESSAGES, makeConfig(), RESPONSE_FORMAT);

    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0]?.[0] as { chatRequest: Record<string, unknown> };
    expect(arg.chatRequest.responseFormat).toEqual(RESPONSE_FORMAT);
    expect(arg.chatRequest.provider).toEqual({ requireParameters: true });
    expect(arg.chatRequest.stream).toBe(false);
  });

  it("WITHOUT a responseFormat sends neither the format nor a provider key", async () => {
    const provider = new OpenRouterProvider();
    await provider.chatCompletionSimple(MESSAGES, makeConfig());

    expect(sendMock).toHaveBeenCalledTimes(1);
    const arg = sendMock.mock.calls[0]?.[0] as { chatRequest: Record<string, unknown> };
    expect("responseFormat" in arg.chatRequest).toBe(false);
    expect("provider" in arg.chatRequest).toBe(false);
  });
});
