/**
 * API-level output-format wiring on the OpenRouter provider.
 *
 * Two layers under pin:
 *   1. `buildOpenRouterParams` spreads a `responseFormat` ONLY when one is
 *      passed; with no arg the request has NO `responseFormat` key, so every
 *      `chatCompletionSimple` caller in the tree stays byte-identical on the
 *      wire.
 *   2. `OpenRouterProvider.chatCompletionSimple` composes `provider.requireParameters`
 *      AROUND `buildOpenRouterParams` (the param unit test can't see that — it
 *      lives at the send call), so a mocked `chat.send` proves that a request WITH
 *      a responseFormat carries BOTH the format AND `provider.requireParameters:true`,
 *      and a request WITHOUT one carries NEITHER.
 *
 * That pairing is exactly why NO caller passes a format today: an endpoint that
 * does not advertise `structured_outputs` is refused before inference, which is
 * what broke the memory judge on 2026-07-31. The mechanism stays pinned because
 * it is the provider's public contract — but its cost is documented here, and a
 * future caller must verify endpoint capability before using it.
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
const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");

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

/**
 * A minimal strict `json_schema` format — the shape a caller would pass. Built
 * inline rather than imported: the judge's builder was DELETED with its last
 * consumer, and the mechanism under test is the provider's, not any caller's.
 */
const RESPONSE_FORMAT = {
  type: "json_schema" as const,
  jsonSchema: {
    name: "probe",
    strict: true,
    schema: { type: "object", additionalProperties: false, properties: {} },
  },
};

describe("buildOpenRouterParams — responseFormat spread", () => {
  it("omits the responseFormat key entirely when none is passed (every caller byte-identical)", () => {
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

describe("OpenRouterProvider.chatCompletionSimple — provider routing composition", () => {
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
