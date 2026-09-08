/**
 * Regression: a caller-supplied `signal` must NOT cost us the configured
 * request deadline.
 *
 * Installed-SDK evidence (`node_modules/@openrouter/sdk/esm/lib/sdks.js`):
 *   :151  `if (!fetchOptions?.signal && conf.timeoutMs != null && conf.timeoutMs > 0)`
 *   :152      `context.timeoutMs = conf.timeoutMs;`
 *   :178  `const timeoutMs = context.timeoutMs;`
 *   :182  `if (timeoutMs != null && timeoutMs > 0) { ... AbortSignal.timeout(timeoutMs) ... }`
 * The client's `timeoutMs` is armed ONLY for sends that pass no signal. Handing
 * the SDK a raw caller signal therefore SILENTLY DISABLES the 300 s ceiling —
 * a hung provider call gets no upper bound at all. The conversational sends
 * gained a caller signal during the cancellation work, so they lost the ceiling
 * with it; this suite pins that they compose the two instead of replacing one
 * with the other.
 *
 * The provider-level cases mock the deadline constant down to a few
 * milliseconds. `AbortSignal.timeout` runs on Node's own timer, NOT the global
 * `setTimeout` that vitest can fake, so the deadline is proven with a real —
 * but tiny — wait rather than with fake timers.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

/** Deadline the provider is built with for the wiring cases below. */
const TEST_DEADLINE_MS = 25;

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

// Shrink ONLY the deadline; everything else in the config module stays real so
// the provider still reads its env config through the production path.
vi.mock("@vex-agent/inference/config.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vex-agent/inference/config.js")>()),
  OPENROUTER_SDK_TIMEOUT_MS: TEST_DEADLINE_MS,
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

const { OpenRouterProvider } = await import("@vex-agent/inference/openrouter.js");
const { composeRequestDeadline } = await import(
  "@vex-agent/inference/openrouter/request-deadline.js"
);

import type {
  InferenceConfig,
  ProviderMessage,
  StreamChunk,
} from "@vex-agent/inference/types.js";

const MESSAGES: ProviderMessage[] = [{ role: "user", content: "hi" }];

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

function bufferedResult() {
  return {
    id: "gen-deadline-1",
    model: "deepseek/deepseek-v4-flash",
    object: "chat.completion",
    created: 1,
    systemFingerprint: "fp",
    choices: [
      { index: 0, finishReason: "stop", message: { role: "assistant", content: "ok" } },
    ],
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  };
}

function eventStream(chunks: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function forwardedSignal(callIndex: number): AbortSignal {
  const options = sendMock.mock.calls[callIndex][1] as { signal?: AbortSignal } | undefined;
  const signal = options?.signal;
  if (!signal) throw new Error("expected a signal on the send options");
  return signal;
}

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of gen) out.push(chunk);
  return out;
}

/** Resolve once `signal` aborts (already-aborted resolves immediately). */
function whenAborted(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/** The `name` an AbortSignal's reason carries, for TimeoutError/AbortError. */
function abortReasonName(signal: AbortSignal): string {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason.name : String(reason);
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.OPENROUTER_API_KEY = "sk-or-test";
  process.env.AGENT_MODEL = "deepseek/deepseek-v4-flash";
});

describe("composeRequestDeadline", () => {
  it("returns undefined with no caller signal, so the SDK arms its own timeout", () => {
    // The SDK only sets `context.timeoutMs` when the send passes NO signal.
    // Returning undefined keeps that path — and the call byte-identical — for
    // callers that use no cancellation.
    expect(composeRequestDeadline(undefined, TEST_DEADLINE_MS)).toBeUndefined();
  });

  it("bounds a caller signal that would otherwise never abort", async () => {
    const controller = new AbortController();
    const composed = composeRequestDeadline(controller.signal, TEST_DEADLINE_MS);
    if (!composed) throw new Error("expected a composed signal");

    expect(composed.aborted).toBe(false);
    await whenAborted(composed);

    expect(composed.aborted).toBe(true);
    // Distinguishable downstream: the deadline reports TimeoutError, and the
    // caller's own signal is untouched — so a `signal.aborted` check against the
    // CALLER (which is what stream-consumer does) still reads "not a user stop".
    expect(abortReasonName(composed)).toBe("TimeoutError");
    expect(controller.signal.aborted).toBe(false);
  });

  it("still cancels on the caller's abort, carrying the caller's reason", async () => {
    const controller = new AbortController();
    const composed = composeRequestDeadline(controller.signal, 60_000);
    if (!composed) throw new Error("expected a composed signal");

    controller.abort();
    await whenAborted(composed);

    expect(composed.aborted).toBe(true);
    // A user stop stays an AbortError, never a TimeoutError — the two must not
    // collapse into one indistinguishable outcome.
    expect(abortReasonName(composed)).toBe("AbortError");
  });

  it("propagates an already-aborted caller signal immediately", () => {
    const composed = composeRequestDeadline(AbortSignal.abort(), 60_000);
    if (!composed) throw new Error("expected a composed signal");

    expect(composed.aborted).toBe(true);
    expect(abortReasonName(composed)).toBe("AbortError");
  });
});

describe("conversational sends stay bounded by the configured deadline", () => {
  it("chatCompletion: a caller signal does not disable the ceiling", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    const controller = new AbortController();

    await new OpenRouterProvider().chatCompletion(
      MESSAGES,
      [],
      makeConfig(),
      undefined,
      controller.signal,
    );

    const forwarded = forwardedSignal(0);
    // Pre-fix this WAS `controller.signal` verbatim, which never aborts on its
    // own — so a hung provider call had no upper bound at all.
    expect(forwarded).not.toBe(controller.signal);
    expect(forwarded.aborted).toBe(false);

    await whenAborted(forwarded);
    expect(abortReasonName(forwarded)).toBe("TimeoutError");
    expect(controller.signal.aborted).toBe(false);
  });

  it("chatCompletionStream: a caller signal does not disable the ceiling", async () => {
    sendMock.mockResolvedValueOnce(eventStream([
      {
        id: "gen-stream-1",
        choices: [{ index: 0, delta: { content: "ok" }, finishReason: "stop" }],
      },
    ]));
    const controller = new AbortController();

    await drain(
      new OpenRouterProvider().chatCompletionStream(
        MESSAGES,
        [],
        makeConfig(),
        controller.signal,
      ),
    );

    const forwarded = forwardedSignal(0);
    expect(forwarded).not.toBe(controller.signal);

    await whenAborted(forwarded);
    expect(abortReasonName(forwarded)).toBe("TimeoutError");
    expect(controller.signal.aborted).toBe(false);
  });

  it("chatCompletionSimple: background one-shots are bounded too", async () => {
    // These already pass their OWN (tighter) deadline, so composing is a no-op
    // in practice — but the guarantee must be structural, not a property of
    // every caller remembering to bring a deadline.
    sendMock.mockResolvedValueOnce(bufferedResult());
    const controller = new AbortController();

    await new OpenRouterProvider().chatCompletionSimple(
      MESSAGES,
      makeConfig(),
      undefined,
      controller.signal,
    );

    const forwarded = forwardedSignal(0);
    expect(forwarded).not.toBe(controller.signal);

    await whenAborted(forwarded);
    expect(abortReasonName(forwarded)).toBe("TimeoutError");
  });

  it("a caller abort still tears the request down before the deadline", async () => {
    sendMock.mockResolvedValueOnce(bufferedResult());
    const controller = new AbortController();

    await new OpenRouterProvider().chatCompletion(
      MESSAGES,
      [],
      makeConfig(),
      undefined,
      controller.signal,
    );

    const forwarded = forwardedSignal(0);
    controller.abort();

    expect(forwarded.aborted).toBe(true);
    expect(abortReasonName(forwarded)).toBe("AbortError");
  });
});
