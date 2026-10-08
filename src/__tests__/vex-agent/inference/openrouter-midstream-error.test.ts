/**
 * WP1 step 3 — mid-stream (post-first-chunk) error normalization.
 *
 * `yield* consumeOpenRouterStream(stream)` used to sit OUTSIDE the try/catch
 * that wraps `client.chat.send`, so a rejection thrown by the stream's async
 * iterator AFTER at least one chunk was yielded reached callers as a raw SDK
 * error — bypassing both classifier metadata (own-property `causeCode`) and
 * message redaction. This pins the fixed behavior: such a rejection now goes
 * through `normalizeOpenRouterError` exactly like the pre-send path.
 *
 * `stream-consumer.ts` (provider-agnostic) is a SEPARATE layer and is
 * deliberately untouched by this change — see its own test file.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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

const { OpenRouterProvider } = await import("../../../vex-agent/inference/openrouter.js");
const { classifyInferenceError, isInferenceTimeout } = await import(
  "../../../vex-agent/inference/attempt-timing.js"
);
const { normalizeOpenRouterError } = await import(
  "../../../vex-agent/inference/openrouter/errors.js"
);
const { classifyMissionRunError } = await import(
  "../../../vex-agent/engine/core/runner/mission-error-classifier.js"
);
const { requireValue } = await import("../../helpers/require-value.js");

import type {
  InferenceConfig,
  ProviderMessage,
  StreamChunk,
} from "../../../vex-agent/inference/types.js";

function makeConfig(): InferenceConfig {
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
  };
}

const MESSAGES: ProviderMessage[] = [{ role: "user", content: "hi" }];

/** Read a (non-enumerable) own-property the way the classifier does. */
function field(err: Error, key: string): unknown {
  return (err as unknown as Record<string, unknown>)[key];
}

describe("OpenRouterProvider.chatCompletionStream — mid-stream error normalization", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
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

  it("normalizes a post-first-chunk generator rejection (scrubbed message, causeCode preserved)", async () => {
    // Yields one content chunk, then the async iterator's `next()` rejects —
    // the shape a dropped connection produces mid-stream — never a chunk
    // with `.error`, so this exercises ONLY the new outer try/catch around
    // `yield* consumeOpenRouterStream(stream)`.
    const asyncIterable = {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          next: async () => {
            if (step === 0) {
              step += 1;
              return {
                value: { choices: [{ delta: { content: "partial" } }] },
                done: false,
              };
            }
            const transportErr = new Error(
              "socket hang up at https://openrouter.ai/api/v1 Bearer sk-or-leak",
            );
            Object.assign(transportErr, { cause: { code: "ECONNRESET" } });
            throw transportErr;
          },
        };
      },
    };
    sendMock.mockResolvedValue(asyncIterable);

    const provider = new OpenRouterProvider();
    const chunks: StreamChunk[] = [];
    let caught: unknown = null;
    try {
      for await (const chunk of provider.chatCompletionStream(MESSAGES, [], makeConfig())) {
        chunks.push(chunk);
      }
    } catch (streamErr) {
      caught = streamErr;
    }

    expect(chunks).toEqual([{ type: "content", text: "partial" }]);
    expect(caught).toBeInstanceOf(Error);
    const normalized = caught as Error;
    expect(normalized.message).toContain(
      "OpenRouter streaming chat completion (mid-stream) failed",
    );
    // Scrubbed — the raw URL/bearer token never reaches the surfaced message.
    expect(normalized.message).not.toContain("openrouter.ai");
    expect(normalized.message).not.toContain("sk-or-leak");
    // causeCode preserved (own-property) for the mission classifier.
    expect(field(normalized, "causeCode")).toBe("ECONNRESET");
  });
});

/**
 * Kairos R-10: a deadline that cuts the body off mid-stream reaches the
 * normalizer as the signal's own `TimeoutError`, which the SDK never wraps.
 * Normalized, it used to be a plain `Error` recorded as `error`.
 */
describe("OpenRouterProvider.chatCompletionStream - mid-stream deadline is a typed timeout", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    sendMock.mockReset();
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

  function streamThatThrowsAfterOneChunk(failure: unknown) {
    return {
      [Symbol.asyncIterator]() {
        let step = 0;
        return {
          next: async () => {
            if (step === 0) {
              step += 1;
              return { value: { choices: [{ delta: { content: "partial" } }] }, done: false };
            }
            throw failure;
          },
        };
      },
    };
  }

  async function midStreamFailure(failure: unknown): Promise<unknown> {
    sendMock.mockResolvedValue(streamThatThrowsAfterOneChunk(failure));
    const provider = new OpenRouterProvider();
    try {
      for await (const _chunk of provider.chatCompletionStream(MESSAGES, [], makeConfig())) {
        // drain
      }
    } catch (err) {
      return err;
    }
    return null;
  }

  it("names a mid-stream deadline TimeoutError so the attempt classifies as timeout", async () => {
    const caught = await midStreamFailure(new DOMException("signal timed out", "TimeoutError"));
    expect(caught).toBeInstanceOf(Error);
    expect(isInferenceTimeout(caught)).toBe(true);
    expect(classifyInferenceError(caught)).toBe("TimeoutError");
    // Mission auto-retry classification is unchanged: a status-less,
    // cause-less failure stays permanent, exactly as the plain Error was.
    expect(classifyMissionRunError(caught)).toBe("permanent");
    expect(
      classifyMissionRunError(
        normalizeOpenRouterError(
          new DOMException("signal timed out", "TimeoutError"),
          "streaming chat completion (mid-stream)",
        ),
      ),
    ).toBe("permanent");
  });

  it("keeps the transport cause code a timeout carries, so mission retry still sees it", async () => {
    const bodyTimeout = new Error("body timeout");
    Object.assign(bodyTimeout, { cause: { code: "UND_ERR_BODY_TIMEOUT" } });
    const caught = await midStreamFailure(bodyTimeout);
    expect(caught).toBeInstanceOf(Error);
    const err = requireValue(caught instanceof Error ? caught : null);
    expect(field(err, "causeCode")).toBe("UND_ERR_BODY_TIMEOUT");
    expect(isInferenceTimeout(err)).toBe(true);
    expect(classifyMissionRunError(err)).toBe("transient");
  });

  it("leaves a non-timeout mid-stream failure a plain normalized Error", async () => {
    const reset = new Error("socket hang up");
    Object.assign(reset, { cause: { code: "ECONNRESET" } });
    const caught = await midStreamFailure(reset);
    const err = requireValue(caught instanceof Error ? caught : null);
    expect(err.name).toBe("Error");
    expect(isInferenceTimeout(err)).toBe(false);
    expect(classifyMissionRunError(err)).toBe("transient");
  });
});
