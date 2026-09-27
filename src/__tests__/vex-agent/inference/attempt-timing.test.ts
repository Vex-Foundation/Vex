import { describe, expect, it } from "vitest";

import {
  classifyInferenceError,
  createInferenceAttemptTimer,
  isInferenceTimeout,
} from "@vex-agent/inference/attempt-timing.js";
import {
  attachCauseCode,
  attachErrorType,
  attachStatus,
  normalizeOpenRouterError,
} from "@vex-agent/inference/openrouter/errors.js";

/** An unnormalized SDK error: only its class name identifies it. */
function sdkError(name: string, message: string, cause?: unknown): Error {
  const err = new Error(message, cause === undefined ? undefined : { cause });
  err.name = name;
  return err;
}

function fakeClock(start = 1_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

describe("createInferenceAttemptTimer", () => {
  it("measures first chunk, first reasoning, first semantic, reasoning-only and max gap", () => {
    const clock = fakeClock();
    const timer = createInferenceAttemptTimer(clock.now);
    timer.markRequestStart();
    clock.advance(200);
    timer.markChunk("reasoning"); // 200
    clock.advance(50);
    timer.markChunk("reasoning"); // 250
    clock.advance(700);
    timer.markChunk("content"); // 950 (gap 700)
    clock.advance(10);
    timer.markChunk("content"); // 960
    clock.advance(5);
    timer.markChunk("usage"); // 965
    clock.advance(35);

    expect(timer.snapshot()).toEqual({
      firstChunkMs: 200,
      firstReasoningMs: 200,
      firstSemanticMs: 950,
      reasoningOnlyMs: 750,
      maxInterChunkGapMs: 700,
      totalMs: 1000,
      chunkCount: 5,
      bufferedFallback: false,
      fallbackReason: null,
      capacityRetries: 0,
      capacityRetryClasses: [],
      toolCallCount: null,
      validToolCallCount: null,
    });
  });

  it("a tool_call_delta counts as the first semantic chunk", () => {
    const clock = fakeClock();
    const timer = createInferenceAttemptTimer(clock.now);
    timer.markRequestStart();
    clock.advance(30);
    timer.markChunk("tool_call_delta");
    const snap = timer.snapshot();
    expect(snap.firstSemanticMs).toBe(30);
    expect(snap.firstReasoningMs).toBeNull();
    expect(snap.reasoningOnlyMs).toBeNull();
  });

  it("reasoning with no semantic chunk runs reasoning-only to the end", () => {
    const clock = fakeClock();
    const timer = createInferenceAttemptTimer(clock.now);
    timer.markRequestStart();
    clock.advance(100);
    timer.markChunk("reasoning");
    clock.advance(400);
    timer.markChunk("done");
    const snap = timer.snapshot(clock.now() + 500);
    expect(snap.firstSemanticMs).toBeNull();
    expect(snap.reasoningOnlyMs).toBe(900);
    expect(snap.totalMs).toBe(1000);
  });

  it("no chunks: all chunk fields null, max gap null with fewer than two chunks", () => {
    const clock = fakeClock();
    const timer = createInferenceAttemptTimer(clock.now);
    timer.markRequestStart();
    clock.advance(20);
    expect(timer.snapshot().maxInterChunkGapMs).toBeNull();
    timer.markChunk("content");
    expect(timer.snapshot().maxInterChunkGapMs).toBeNull();
    const empty = createInferenceAttemptTimer(clock.now);
    empty.markRequestStart();
    clock.advance(5);
    expect(empty.snapshot()).toMatchObject({
      firstChunkMs: null,
      firstReasoningMs: null,
      firstSemanticMs: null,
      reasoningOnlyMs: null,
      maxInterChunkGapMs: null,
      totalMs: 5,
      chunkCount: 0,
    });
  });

  it("records fallback, capacity failures and tool-call counts", () => {
    const timer = createInferenceAttemptTimer(fakeClock().now);
    timer.markRequestStart();
    timer.markCapacityFailure("rate_limited");
    timer.markCapacityFailure("upstream_5xx");
    timer.markBufferedFallback("setup_threw");
    timer.markToolCalls(3, 2);
    const snap = timer.snapshot();
    expect(snap).toMatchObject({
      bufferedFallback: true,
      fallbackReason: "setup_threw",
      capacityRetries: 2,
      capacityRetryClasses: ["rate_limited", "upstream_5xx"],
      toolCallCount: 3,
      validToolCallCount: 2,
    });
    // The snapshot owns its array: later marks do not rewrite a taken snapshot.
    timer.markCapacityFailure("other");
    expect(snap.capacityRetryClasses).toEqual(["rate_limited", "upstream_5xx"]);
  });
});

describe("classifyInferenceError", () => {
  const SECRET = "sk-or-v1-deadbeef https://example.com/?token=abc 0xabc123 amount 5";

  it("uses the name only, never the message", () => {
    const err = new TypeError(SECRET);
    const out = classifyInferenceError(err);
    expect(out).toBe("TypeError");
    expect(out).not.toContain("sk-or");
  });

  it("adds status and errorType own-properties", () => {
    const err = attachErrorType(attachStatus(new Error(SECRET), 429), "rate_limit_exceeded");
    expect(classifyInferenceError(err)).toBe("Error:status=429:type=rate_limit_exceeded");
  });

  it("reads a plain status own-property", () => {
    const err = Object.assign(new Error(SECRET), { status: 502 });
    expect(classifyInferenceError(err)).toBe("Error:status=502");
  });

  it("recognises abort errors", () => {
    const dom = new Error(SECRET);
    dom.name = "AbortError";
    expect(classifyInferenceError(dom)).toBe("AbortError");
    const node = Object.assign(new Error(SECRET), { code: "ABORT_ERR" });
    expect(classifyInferenceError(node)).toBe("AbortError");
  });

  it("drops a name or errorType that is not a bounded label", () => {
    const err = new Error("x");
    err.name = SECRET;
    attachErrorType(err, "free text with spaces " + SECRET);
    const out = classifyInferenceError(err);
    expect(out).toBe("unknown");
  });

  it("uses the SDK class a normalized error carries in place of the generic name", () => {
    const normalized = normalizeOpenRouterError(
      sdkError("RequestTimeoutError", SECRET),
      "streaming chat completion",
    );
    expect(normalized.name).toBe("Error");
    const out = classifyInferenceError(normalized);
    expect(out).toBe("RequestTimeoutError");
    expect(out).not.toContain("sk-or");
  });

  it("non-objects are unknown", () => {
    expect(classifyInferenceError(SECRET)).toBe("unknown");
    expect(classifyInferenceError(null)).toBe("unknown");
    expect(classifyInferenceError(undefined)).toBe("unknown");
  });
});

describe("isInferenceTimeout", () => {
  const SECRET = "sk-or-v1-deadbeef timed out talking to https://example.com";

  it("matches the AbortSignal.timeout deadline", async () => {
    const signal = AbortSignal.timeout(1);
    await new Promise((r) => setTimeout(r, 5));
    expect(signal.reason).toBeInstanceOf(DOMException);
    expect(isInferenceTimeout(signal.reason)).toBe(true);
  });

  it("matches the SDK's request timeout, raw and normalized", () => {
    const raw = sdkError("RequestTimeoutError", SECRET);
    expect(isInferenceTimeout(raw)).toBe(true);
    expect(isInferenceTimeout(normalizeOpenRouterError(raw, "chat completion"))).toBe(true);
  });

  it("matches upstream 408 and 524 timeout responses once normalized", () => {
    for (const name of ["RequestTimeoutResponseError", "EdgeNetworkTimeoutResponseError"]) {
      expect(isInferenceTimeout(normalizeOpenRouterError(sdkError(name, SECRET), "x"))).toBe(true);
    }
  });

  it("matches a transport timeout cause code, own or one level down", () => {
    expect(isInferenceTimeout(attachCauseCode(new Error(SECRET), "UND_ERR_HEADERS_TIMEOUT")))
      .toBe(true);
    expect(isInferenceTimeout(new Error(SECRET, { cause: { code: "ETIMEDOUT" } }))).toBe(true);
  });

  it("never matches a caller abort", () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(isInferenceTimeout(ctrl.signal.reason)).toBe(false);
    expect(isInferenceTimeout(sdkError("RequestAbortedError", SECRET))).toBe(false);
  });

  it("never matches ordinary failures or message text", () => {
    expect(isInferenceTimeout(new Error("TimeoutError: request timed out"))).toBe(false);
    expect(isInferenceTimeout(Object.assign(new Error(SECRET), { status: 502 }))).toBe(false);
    expect(isInferenceTimeout(sdkError("ServiceUnavailableResponseError", SECRET))).toBe(false);
    expect(isInferenceTimeout(null)).toBe(false);
    expect(isInferenceTimeout("TimeoutError")).toBe(false);
  });
});
