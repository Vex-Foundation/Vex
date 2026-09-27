/**
 * Kairos Phase 2B stream bounds (R-3, R-4, R-6) in `runStreamingInference`.
 *
 * Driven entirely by fake timers and typed fake providers whose waits honour
 * the request signal the consumer hands them, the way the SDK's fetch does.
 * Every case ends by asserting that no timer is left behind.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real logger arms its own flush timer; mocked so `vi.getTimerCount()`
// counts only the timers the code under test owns.
const loggerMock = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@utils/logger.js", () => ({ default: loggerMock, logger: loggerMock }));

import { runStreamingInference } from "@vex-agent/inference/stream-consumer.js";
import { isInferenceTimeout } from "@vex-agent/inference/attempt-timing.js";
import { attachStatus } from "@vex-agent/inference/openrouter/errors.js";
import { sendWithEndpointFailover } from "@vex-agent/inference/openrouter/endpoint-failover.js";
import type {
  InferenceConfig,
  InferenceProvider,
  InferenceResponse,
  StreamChunk,
} from "@vex-agent/inference/types.js";

import { fakeInferenceProvider } from "../../helpers/inference-provider.js";
import { requireValue } from "../../helpers/require-value.js";

const USAGE = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function config(overrides: Partial<InferenceConfig> = {}): InferenceConfig {
  return {
    provider: "fake",
    model: "fake/model",
    contextLimit: 100_000,
    maxOutputTokens: 1_000,
    inputPricePerM: 0,
    outputPricePerM: 0,
    priceCurrency: "USD",
    cachePricePerM: null,
    cacheWritePricePerM: null,
    reasoningPricePerM: null,
    supportsReasoningEffort: false,
    ...overrides,
  };
}

/** Short bounds so each one is individually reachable in a test. */
const BOUNDS: Partial<InferenceConfig> = {
  firstChunkTimeoutMs: 1_000,
  streamIdleTimeoutMs: 500,
  reasoningOnlyTimeoutMs: 2_000,
  inferenceRoundDeadlineMs: 10_000,
};

/** A signal-honouring wait, like a fetch body read: rejects with the reason. */
function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Wait forever unless the signal aborts. */
function hang(signal: AbortSignal | undefined): Promise<void> {
  return new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

interface Step {
  readonly afterMs: number;
  readonly chunk: StreamChunk;
}

interface ScriptedStream {
  readonly provider: InferenceProvider;
  /** The signal the consumer handed the provider (last call). */
  readonly seen: { signal: AbortSignal | undefined; calls: number; closed: boolean };
  readonly chatCompletion: ReturnType<typeof vi.fn<InferenceProvider["chatCompletion"]>>;
}

/**
 * A stream that emits `steps` (each after its own delay) and then either ends
 * or hangs until aborted.
 */
function scripted(steps: readonly Step[], end: "done" | "hang"): ScriptedStream {
  const seen: ScriptedStream["seen"] = { signal: undefined, calls: 0, closed: false };
  const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>();
  const provider = fakeInferenceProvider({
    chatCompletion,
    chatCompletionStream: async function* (_m, _t, _c, signal): AsyncGenerator<StreamChunk> {
      seen.signal = signal;
      seen.calls += 1;
      try {
        for (const step of steps) {
          if (step.afterMs > 0) await wait(step.afterMs, signal);
          yield step.chunk;
        }
        if (end === "hang") await hang(signal);
      } finally {
        seen.closed = true;
      }
    },
  });
  return { provider, seen, chatCompletion };
}

function content(text: string, afterMs: number): Step {
  return { afterMs, chunk: { type: "content", text } };
}
function reasoning(text: string, afterMs: number): Step {
  return { afterMs, chunk: { type: "reasoning", reasoningText: text } };
}

const DONE: Step = { afterMs: 0, chunk: { type: "done", finishReason: "stop" } };

function bufferedAnswer(text: string): InferenceResponse {
  return {
    content: text,
    toolCalls: null,
    usage: USAGE,
    reasoning: null,
    finishReason: "stop",
    generationId: null,
    servingProvider: null,
    malformedToolCallCount: 0,
  };
}

/** Settle a promise under fake timers, reporting whether it settled yet. */
function track<T>(promise: Promise<T>) {
  const state: { settled: boolean; value?: T; error?: unknown } = { settled: false };
  promise.then(
    (value) => {
      state.settled = true;
      state.value = value;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return state;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("first-chunk bound", () => {
  it("fires exactly at the bound and returns timedOut first_chunk with nothing streamed", async () => {
    const { provider, seen, chatCompletion } = scripted([], "hang");
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));

    await vi.advanceTimersByTimeAsync(999);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(run.settled).toBe(true);

    const result = requireValue(run.value);
    expect(result.timedOut).toBe("first_chunk");
    expect(result.aborted).toBe(false);
    expect(result.usageObserved).toBe(false);
    expect(result.response).toEqual({
      content: "",
      toolCalls: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      reasoning: null,
      finishReason: null,
      generationId: null,
      servingProvider: null,
      malformedToolCallCount: 0,
    });
    // The request-local signal was aborted with a typed timeout; the bound is
    // never a fallback.
    const signal = requireValue(seen.signal);
    expect(signal.aborted).toBe(true);
    expect(isInferenceTimeout(signal.reason)).toBe(true);
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("still returns when the provider ignores its signal and never settles", async () => {
    const provider = fakeInferenceProvider({
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        await new Promise<void>(() => {});
      },
    });
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requireValue(run.value).timedOut).toBe("first_chunk");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is cleared by the first chunk of any type", async () => {
    const { provider } = scripted(
      [{ afterMs: 900, chunk: { type: "usage", usage: USAGE } }, content("ok", 400), DONE],
      "done",
    );
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(1_400);
    const result = requireValue(run.value);
    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("ok");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("idle bound", () => {
  it("fires after the configured silence and keeps the text that streamed", async () => {
    const { provider, seen } = scripted([content("Hel", 100), content("lo", 200)], "hang");
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));

    // Last chunk at t=300; idle is 500 ms.
    await vi.advanceTimersByTimeAsync(799);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = requireValue(run.value);
    expect(result.timedOut).toBe("idle");
    expect(result.aborted).toBe(false);
    expect(result.response.content).toBe("Hel" + "lo");
    expect(result.response.toolCalls).toBeNull();
    expect(result.response.finishReason).toBeNull();
    expect(seen.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is reset by every chunk, reasoning and usage included", async () => {
    const { provider } = scripted(
      [
        reasoning("a", 400),
        reasoning("b", 400),
        { afterMs: 400, chunk: { type: "usage", usage: USAGE } },
        reasoning("c", 400),
        content("answer", 400),
        content(".", 400),
        DONE,
      ],
      "done",
    );
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(2_400);
    const result = requireValue(run.value);
    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("answer.");
    expect(result.response.reasoning).toBe("abc");
    expect(result.usageObserved).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops in-flight tool calls: a timed-out round never carries one", async () => {
    const { provider } = scripted(
      [
        {
          afterMs: 50,
          chunk: {
            type: "tool_call_delta",
            toolCallIndex: 0,
            toolCallId: "call-1",
            toolCallName: "transfer",
            toolCallArgsDelta: '{"to":"0x1","amount":"1"}',
          },
        },
      ],
      "hang",
    );
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(550);
    const result = requireValue(run.value);
    expect(result.timedOut).toBe("idle");
    expect(result.response.toolCalls).toBeNull();
    expect(result.response.malformedToolCallCount).toBe(0);
    expect(result.response.content).toBe("");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("reasoning-only bound", () => {
  it("fires when reasoning never turns into content or a tool call", async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 20; i++) steps.push(reasoning(`r${i}`, 300));
    const { provider } = scripted(steps, "hang");
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));

    // First reasoning chunk at t=300; the bound is 2,000 ms from there.
    await vi.advanceTimersByTimeAsync(2_299);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = requireValue(run.value);
    expect(result.timedOut).toBe("reasoning_only");
    expect(result.response.content).toBe("");
    expect(requireValue(result.response.reasoning).startsWith("r0r1")).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is cancelled by the first content delta", async () => {
    const steps: Step[] = [reasoning("think", 100), content("A", 300)];
    for (let i = 0; i < 10; i++) steps.push(content("a", 300));
    steps.push(DONE);
    const { provider } = scripted(steps, "done");
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(3_400);
    const result = requireValue(run.value);
    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("A" + "a".repeat(10));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("is cancelled by the first tool-call delta", async () => {
    const steps: Step[] = [
      reasoning("think", 100),
      {
        afterMs: 300,
        chunk: { type: "tool_call_delta", toolCallIndex: 0, toolCallId: "c1", toolCallName: "read" },
      },
    ];
    for (let i = 0; i < 8; i++) {
      steps.push({ afterMs: 300, chunk: { type: "tool_call_delta", toolCallIndex: 0, toolCallArgsDelta: " " } });
    }
    steps.push({ afterMs: 300, chunk: { type: "tool_call_delta", toolCallIndex: 0, toolCallArgsDelta: "{}" } });
    steps.push(DONE);
    const { provider } = scripted(steps, "done");
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(3_100);
    const result = requireValue(run.value);
    expect(result.timedOut).toBeNull();
    expect(result.response.toolCalls).toEqual([{ id: "c1", name: "read", arguments: {} }]);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("round deadline (R-6)", () => {
  it("fires mid-stream on a stream that keeps talking", async () => {
    const steps: Step[] = [];
    for (let i = 0; i < 100; i++) steps.push(content("x", 400));
    const { provider } = scripted(steps, "done");
    const run = track(
      runStreamingInference(provider, [], [], config({ ...BOUNDS, inferenceRoundDeadlineMs: 3_000 })),
    );
    await vi.advanceTimersByTimeAsync(2_999);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = requireValue(run.value);
    expect(result.timedOut).toBe("round_deadline");
    expect(result.response.content).toBe("x".repeat(7));
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps the endpoint failover's retries and backoff inside one budget, with no fallback", async () => {
    const attempts: number[] = [];
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>();
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (_m, _t, c, signal): AsyncGenerator<StreamChunk> {
        const inner = await sendWithEndpointFailover<AsyncIterable<StreamChunk>>(
          async () => {
            attempts.push(Date.now());
            // Each attempt spends 1.5 s and fails with a capacity 503.
            await wait(1_500, signal);
            throw attachStatus(new Error("upstream overloaded"), 503);
          },
          c,
          undefined,
          { loadCandidates: async () => [], sleep: wait },
          signal,
        );
        yield* inner;
      },
    });
    const start = Date.now();
    const run = track(
      runStreamingInference(
        provider,
        [],
        [],
        config({ firstChunkTimeoutMs: 0, inferenceRoundDeadlineMs: 4_000 }),
      ),
    );
    // Unbounded, three attempts plus two backoffs would take well past 5 s.
    await vi.advanceTimersByTimeAsync(3_999);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = requireValue(run.value);
    expect(result.timedOut).toBe("round_deadline");
    expect(Date.now() - start).toBe(4_000);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("gives the buffered fallback only the budget that is left", async () => {
    let fallbackSignal: AbortSignal | undefined;
    let fallbackStartedAt = 0;
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>(
      async (_m, _t, _c, _ctx, signal) => {
        fallbackSignal = signal;
        fallbackStartedAt = Date.now();
        await hang(signal);
        return bufferedAnswer("never");
      },
    );
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (_m, _t, _c, signal): AsyncGenerator<StreamChunk> {
        await wait(1_000, signal);
        throw new Error("this endpoint cannot stream");
      },
    });
    const start = Date.now();
    const run = track(
      runStreamingInference(
        provider,
        [],
        [],
        config({ firstChunkTimeoutMs: 0, inferenceRoundDeadlineMs: 3_000 }),
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(fallbackStartedAt - start).toBe(1_000);

    await vi.advanceTimersByTimeAsync(1_999);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    const result = requireValue(run.value);
    expect(result.timedOut).toBe("round_deadline");
    expect(result.usageObserved).toBe(false);
    // Cut off 2 s into the fallback: the remaining budget, not a fresh one.
    expect(Date.now() - fallbackStartedAt).toBe(2_000);
    expect(isInferenceTimeout(requireValue(fallbackSignal).reason)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a fallback that answers in time is returned as before", async () => {
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>(
      async (_m, _t, _c, _ctx, signal) => {
        await wait(500, signal);
        return bufferedAnswer("buffered");
      },
    );
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        throw new Error("this endpoint cannot stream");
      },
    });
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(500);
    const result = requireValue(run.value);
    expect(result).toEqual({
      response: bufferedAnswer("buffered"),
      aborted: false,
      usageObserved: true,
      timedOut: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("buffered fallback only for genuine stream incompatibility", () => {
  it("a timeout thrown before the first chunk propagates and never falls back", async () => {
    const timeout = new Error("Request timed out");
    timeout.name = "RequestTimeoutError";
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>();
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        throw timeout;
      },
    });
    await expect(runStreamingInference(provider, [], [], config())).rejects.toBe(timeout);
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a setup throw that is a deadline propagates and never falls back", async () => {
    const deadline = new DOMException("signal timed out", "TimeoutError");
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>();
    const provider = fakeInferenceProvider({ chatCompletion });
    Reflect.set(provider, "chatCompletionStream", () => {
      throw deadline;
    });
    await expect(runStreamingInference(provider, [], [], config(BOUNDS))).rejects.toBe(deadline);
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a first-chunk bound that fires is returned as timedOut, never as a fallback", async () => {
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>();
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (_m, _t, _c, signal): AsyncGenerator<StreamChunk> {
        // The SDK surfaces the abort as its own timeout error.
        try {
          await hang(signal);
        } catch {
          const wrapped = new Error("Request timed out");
          wrapped.name = "RequestTimeoutError";
          throw wrapped;
        }
      },
    });
    const run = track(runStreamingInference(provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(requireValue(run.value).timedOut).toBe("first_chunk");
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a genuine (status-less) stream failure before the first chunk still falls back", async () => {
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>(
      async () => bufferedAnswer("buffered"),
    );
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        throw new Error("response was not an event stream");
      },
    });
    const result = await runStreamingInference(provider, [], [], config(BOUNDS));
    expect(result.response.content).toBe("buffered");
    expect(result.timedOut).toBeNull();
    expect(chatCompletion).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a provider status (502) before the first chunk propagates, never a fallback", async () => {
    const chatCompletion = vi.fn<InferenceProvider["chatCompletion"]>(
      async () => bufferedAnswer("buffered"),
    );
    const err = attachStatus(new Error("bad gateway"), 502);
    const provider = fakeInferenceProvider({
      chatCompletion,
      chatCompletionStream: async function* (): AsyncGenerator<StreamChunk> {
        throw err;
      },
    });
    await expect(runStreamingInference(provider, [], [], config(BOUNDS))).rejects.toBe(err);
    expect(chatCompletion).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("caller Stop", () => {
  it("mid-stream stays aborted, never timedOut, and clears every bound", async () => {
    const controller = new AbortController();
    const { provider } = scripted([content("part", 100)], "hang");
    const run = track(
      runStreamingInference(provider, [], [], config(BOUNDS), { signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(200);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);

    const result = requireValue(run.value);
    expect(result.aborted).toBe(true);
    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("part");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the consumer's request signal still carries the caller's Stop", async () => {
    const controller = new AbortController();
    const { provider, seen } = scripted([], "hang");
    const run = track(
      runStreamingInference(provider, [], [], config(BOUNDS), { signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(10);
    controller.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(requireValue(seen.signal).aborted).toBe(true);
    expect(requireValue(run.value).aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("bounds off (0 or absent) = previous behaviour", () => {
  it("absent bounds pass the caller's own signal through and never time out", async () => {
    const controller = new AbortController();
    const { provider, seen } = scripted([content("late", 3_600_000), DONE], "done");
    const run = track(
      runStreamingInference(provider, [], [], config(), { signal: controller.signal }),
    );
    await vi.advanceTimersByTimeAsync(3_600_000);
    const result = requireValue(run.value);
    expect(seen.signal).toBe(controller.signal);
    expect(result.timedOut).toBeNull();
    expect(result.response.content).toBe("late");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("all-zero bounds with no caller signal hand the provider no signal at all", async () => {
    const { provider, seen } = scripted([content("late", 900_000), DONE], "done");
    const zero = config({
      firstChunkTimeoutMs: 0,
      streamIdleTimeoutMs: 0,
      reasoningOnlyTimeoutMs: 0,
      inferenceRoundDeadlineMs: 0,
    });
    const run = track(runStreamingInference(provider, [], [], zero));
    await vi.advanceTimersByTimeAsync(900_000);
    expect(seen.signal).toBeUndefined();
    expect(requireValue(run.value).timedOut).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a single disabled bound is skipped while the others still apply", async () => {
    const { provider } = scripted([content("a", 100)], "hang");
    const run = track(
      runStreamingInference(
        provider,
        [],
        [],
        config({ ...BOUNDS, streamIdleTimeoutMs: 0, inferenceRoundDeadlineMs: 5_000 }),
      ),
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(run.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(requireValue(run.value).timedOut).toBe("round_deadline");
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("no leaked timers", () => {
  it("a normal completion, a thrown provider error and a pre-aborted call leave nothing armed", async () => {
    const ok = scripted([content("hi", 10), DONE], "done");
    const run = track(runStreamingInference(ok.provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(10);
    expect(requireValue(run.value).response.content).toBe("hi");
    expect(vi.getTimerCount()).toBe(0);

    const failing = scripted(
      [content("x", 10), { afterMs: 10, chunk: { type: "error", errorMessage: "boom", errorCode: 500 } }],
      "done",
    );
    const failed = track(runStreamingInference(failing.provider, [], [], config(BOUNDS)));
    await vi.advanceTimersByTimeAsync(20);
    expect(failed.error).toBeInstanceOf(Error);
    expect(failing.seen.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    const stopped = new AbortController();
    stopped.abort();
    const pre = await runStreamingInference(ok.provider, [], [], config(BOUNDS), {
      signal: stopped.signal,
    });
    expect(pre.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
