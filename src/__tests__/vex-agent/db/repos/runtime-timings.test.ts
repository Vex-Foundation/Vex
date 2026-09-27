/**
 * runtime-timings repo — column/parameter wiring for the three telemetry
 * tables added by migration 171, and the fire-and-forget contract of
 * `recordInBackground`, including its in-flight cap and throttled drop log.
 *
 * Parameters are asserted POSITIONALLY against the column list parsed out of
 * the SQL itself, so a column added without its parameter (or vice versa)
 * fails here rather than as a silently dropped telemetry row in production.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

import { requireValue } from "../../../helpers/require-value.js";

const mockExecute = vi.fn();
const mockWarn = vi.fn();

vi.mock("@vex-agent/db/client.js", () => ({
  execute: (...a: unknown[]) => mockExecute(...a),
  query: vi.fn().mockResolvedValue([]),
  queryOne: vi.fn().mockResolvedValue(null),
}));

vi.mock("@utils/logger.js", () => ({
  default: {
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: (...a: unknown[]) => mockWarn(...a),
  },
}));

const {
  insertInferenceAttempt,
  insertToolDispatchTiming,
  insertTurnRunTiming,
  recordInBackground,
  getTelemetryWriteStats,
  resetTelemetryWriteStatsForTests,
  MAX_IN_FLIGHT_TELEMETRY_WRITES,
  DROPPED_LOG_INTERVAL_MS,
} = await import("@vex-agent/db/repos/runtime-timings.js");

type InferenceAttemptRecord = Parameters<typeof insertInferenceAttempt>[0];

/** Map each named column in the INSERT to the parameter bound for it. */
function boundRow(): Record<string, unknown> {
  expect(mockExecute).toHaveBeenCalledTimes(1);
  const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
  const columnList = /\(([^)]*)\)\s*VALUES/s.exec(sql)?.[1];
  expect(columnList).toBeDefined();
  const columns = requireValue(columnList).split(",").map((c) => c.trim());
  const placeholders = [...sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
  expect(placeholders).toEqual(columns.map((_, i) => i + 1));
  expect(params).toHaveLength(columns.length);
  return Object.fromEntries(columns.map((c, i) => [c, params[i]]));
}

const STARTED_AT = new Date("2026-09-27T10:00:00.000Z");

function attempt(overrides: Partial<InferenceAttemptRecord> = {}): InferenceAttemptRecord {
  return {
    sessionId: "session-1",
    missionRunId: "run-1",
    turnRunId: "turn-run-1",
    iteration: 3,
    streamId: "stream-1",
    startedAt: STARTED_AT,
    outcome: "completed",
    errorClass: null,
    model: "anthropic/claude-sonnet-4",
    endpointTag: "anthropic/fp8",
    servingProvider: "Anthropic",
    requestedEffort: "high",
    bufferedFallback: false,
    fallbackReason: null,
    capacityRetries: 1,
    capacityRetryClasses: ["rate_limited"],
    preInferenceMs: 12.4,
    promptStackMs: 3.5,
    firstChunkMs: 801.49,
    firstReasoningMs: 801.5,
    firstSemanticMs: 2400.6,
    reasoningOnlyMs: 1599.1,
    maxInterChunkGapMs: 350.2,
    totalMs: 5012.7,
    chunkCount: 140,
    finishReason: "tool_calls",
    contentEmpty: true,
    toolCallCount: 2,
    validToolCallCount: 1,
    promptTokens: 30000,
    completionTokens: 900,
    reasoningTokens: 500,
    cachedTokens: 24000,
    generationId: "gen-1",
    ...overrides,
  };
}

describe("runtime-timings repo — insertInferenceAttempt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("binds every field to its snake_case column", async () => {
    await insertInferenceAttempt(attempt());
    const [sql] = mockExecute.mock.calls[0] as [string];
    expect(sql).toContain("INSERT INTO inference_attempts");
    expect(boundRow()).toEqual({
      session_id: "session-1",
      mission_run_id: "run-1",
      turn_run_id: "turn-run-1",
      iteration: 3,
      stream_id: "stream-1",
      started_at: STARTED_AT,
      outcome: "completed",
      error_class: null,
      model: "anthropic/claude-sonnet-4",
      endpoint_tag: "anthropic/fp8",
      serving_provider: "Anthropic",
      requested_effort: "high",
      buffered_fallback: false,
      fallback_reason: null,
      capacity_retries: 1,
      capacity_retry_classes: ["rate_limited"],
      pre_inference_ms: 12,
      prompt_stack_ms: 4,
      first_chunk_ms: 801,
      first_reasoning_ms: 802,
      first_semantic_ms: 2401,
      reasoning_only_ms: 1599,
      max_inter_chunk_gap_ms: 350,
      total_ms: 5013,
      chunk_count: 140,
      finish_reason: "tool_calls",
      content_empty: true,
      tool_call_count: 2,
      valid_tool_call_count: 1,
      prompt_tokens: 30000,
      completion_tokens: 900,
      reasoning_tokens: 500,
      cached_tokens: 24000,
      generation_id: "gen-1",
    });
  });

  it("keeps unknown values NULL rather than coercing them to 0 or false", async () => {
    await insertInferenceAttempt(attempt({
      missionRunId: null,
      streamId: null,
      outcome: "error",
      errorClass: "APIError:429",
      endpointTag: null,
      servingProvider: null,
      requestedEffort: null,
      capacityRetries: 0,
      capacityRetryClasses: [],
      preInferenceMs: null,
      promptStackMs: null,
      firstChunkMs: null,
      firstReasoningMs: null,
      firstSemanticMs: null,
      reasoningOnlyMs: null,
      maxInterChunkGapMs: null,
      chunkCount: 0,
      finishReason: null,
      contentEmpty: null,
      toolCallCount: null,
      validToolCallCount: null,
      promptTokens: null,
      completionTokens: null,
      reasoningTokens: null,
      cachedTokens: null,
      generationId: null,
    }));
    const row = boundRow();
    for (const col of [
      "mission_run_id", "stream_id", "endpoint_tag", "serving_provider", "requested_effort",
      "pre_inference_ms", "prompt_stack_ms", "first_chunk_ms", "first_reasoning_ms",
      "first_semantic_ms", "reasoning_only_ms", "max_inter_chunk_gap_ms",
      "finish_reason", "content_empty", "tool_call_count", "valid_tool_call_count",
      "prompt_tokens", "completion_tokens", "reasoning_tokens", "cached_tokens",
      "generation_id",
    ]) {
      expect(row[col], col).toBeNull();
    }
    expect(row.outcome).toBe("error");
    expect(row.error_class).toBe("APIError:429");
    expect(row.capacity_retry_classes).toEqual([]);
  });

  it("binds a timeout outcome with its error class", async () => {
    await insertInferenceAttempt(attempt({ outcome: "timeout", errorClass: "RequestTimeoutError" }));
    const row = boundRow();
    expect(row.outcome).toBe("timeout");
    expect(row.error_class).toBe("RequestTimeoutError");
  });

  it("passes a plain array copy of the readonly retry classes", async () => {
    const classes = Object.freeze(["rate_limited", "overloaded"]);
    await insertInferenceAttempt(attempt({ capacityRetryClasses: classes }));
    const bound = boundRow().capacity_retry_classes;
    expect(bound).toEqual(["rate_limited", "overloaded"]);
    expect(bound).not.toBe(classes);
  });

  it("propagates a write failure to the caller (recordInBackground is the guard)", async () => {
    mockExecute.mockRejectedValueOnce(new Error("boom"));
    await expect(insertInferenceAttempt(attempt())).rejects.toThrow("boom");
  });
});

describe("runtime-timings repo — insertToolDispatchTiming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("binds every field and rounds duration_ms", async () => {
    await insertToolDispatchTiming({
      sessionId: "session-1",
      turnRunId: "turn-run-1",
      iteration: 2,
      toolCallId: "call-1",
      toolName: "get_balances",
      actionKind: "read",
      startedAt: STARTED_AT,
      durationMs: 41.5,
      outcome: "failure",
    });
    const [sql] = mockExecute.mock.calls[0] as [string];
    expect(sql).toContain("INSERT INTO tool_dispatch_timings");
    expect(boundRow()).toEqual({
      session_id: "session-1",
      turn_run_id: "turn-run-1",
      iteration: 2,
      tool_call_id: "call-1",
      tool_name: "get_balances",
      action_kind: "read",
      started_at: STARTED_AT,
      duration_ms: 42,
      outcome: "failure",
    });
  });

  it("keeps a missing tool call id and action kind NULL", async () => {
    await insertToolDispatchTiming({
      sessionId: "session-1",
      turnRunId: "turn-run-1",
      iteration: 0,
      toolCallId: null,
      toolName: "search",
      actionKind: null,
      startedAt: STARTED_AT,
      durationMs: 0.2,
      outcome: "error",
    });
    const row = boundRow();
    expect(row.tool_call_id).toBeNull();
    expect(row.action_kind).toBeNull();
    expect(row.duration_ms).toBe(0);
  });
});

describe("runtime-timings repo — insertTurnRunTiming", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecute.mockResolvedValue(undefined);
  });

  it("binds every field and rounds total_ms", async () => {
    await insertTurnRunTiming({
      turnRunId: "turn-run-1",
      sessionId: "session-1",
      missionRunId: null,
      sessionKind: "chat",
      startedAt: STARTED_AT,
      totalMs: 9999.5,
      iterations: 4,
      toolCalls: 6,
      queueWaitMs: 41.6,
      persistMs: 7.4,
      outcome: "error",
      stopReason: null,
      errorClass: "AbortError",
    });
    const [sql] = mockExecute.mock.calls[0] as [string];
    expect(sql).toContain("INSERT INTO turn_run_timings");
    expect(boundRow()).toEqual({
      turn_run_id: "turn-run-1",
      session_id: "session-1",
      mission_run_id: null,
      session_kind: "chat",
      started_at: STARTED_AT,
      total_ms: 10000,
      iterations: 4,
      tool_calls: 6,
      queue_wait_ms: 42,
      persist_ms: 7,
      outcome: "error",
      stop_reason: null,
      error_class: "AbortError",
    });
  });
});

describe("runtime-timings repo — recordInBackground", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetTelemetryWriteStatsForTests();
  });

  it("returns synchronously without awaiting the write", () => {
    let settled = false;
    const result = recordInBackground("inference_attempt", () =>
      new Promise<void>((resolve) => setTimeout(() => { settled = true; resolve(); }, 10)));
    expect(result).toBeUndefined();
    expect(settled).toBe(false);
  });

  it("swallows a rejected write and logs only the label and error class", async () => {
    class DatabaseError extends Error {
      override name = "DatabaseError";
    }
    const write = vi.fn(() =>
      Promise.reject(new DatabaseError("value 'secret-arg' violates constraint")));

    expect(() => recordInBackground("tool_dispatch", write)).not.toThrow();
    await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(1));

    expect(write).toHaveBeenCalledTimes(1);
    expect(mockWarn).toHaveBeenCalledWith("runtime_timings.write_failed", {
      label: "tool_dispatch",
      errorClass: "DatabaseError",
    });
    expect(JSON.stringify(mockWarn.mock.calls)).not.toContain("secret-arg");
  });

  it("swallows a write that throws synchronously", () => {
    expect(() => recordInBackground("turn_run", () => {
      throw new TypeError("bad");
    })).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith("runtime_timings.write_failed", {
      label: "turn_run",
      errorClass: "TypeError",
    });
  });

  it("does not throw when the logger itself fails", async () => {
    mockWarn.mockImplementationOnce(() => { throw new Error("logger down"); });
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      recordInBackground("inference_attempt", () => Promise.reject(new Error("x")));
      await vi.waitFor(() => expect(mockWarn).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("does not log when the write succeeds", async () => {
    const write = vi.fn(() => Promise.resolve());
    recordInBackground("inference_attempt", write);
    await new Promise((r) => setTimeout(r, 0));
    expect(write).toHaveBeenCalledTimes(1);
    expect(mockWarn).not.toHaveBeenCalled();
  });
});

describe("runtime-timings repo — recordInBackground in-flight cap", () => {
  let nowMs = 0;

  /** A write that stays pending until the test settles it. */
  function pendingWrite(): { write: () => Promise<void>; resolve: () => void; reject: (err: Error) => void } {
    let resolve: () => void = () => undefined;
    let reject: (err: Error) => void = () => undefined;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { write: () => promise, resolve, reject };
  }

  function fillToCap(): Array<ReturnType<typeof pendingWrite>> {
    const writes = Array.from({ length: MAX_IN_FLIGHT_TELEMETRY_WRITES }, () => pendingWrite());
    for (const w of writes) recordInBackground("inference_attempt", w.write);
    return writes;
  }

  const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const droppedLogs = (): unknown[][] => mockWarn.mock.calls.filter((c) => c[0] === "runtime_timings.dropped");

  beforeEach(() => {
    vi.clearAllMocks();
    nowMs = 1_000;
    resetTelemetryWriteStatsForTests(() => nowMs);
  });

  it("caps in-flight writes and drops, without calling or queueing, the ones past the cap", async () => {
    expect(MAX_IN_FLIGHT_TELEMETRY_WRITES).toBe(4);
    const writes = fillToCap();
    expect(getTelemetryWriteStats()).toEqual({ inFlight: 4, dropped: 0 });

    const overflow = vi.fn(() => Promise.resolve());
    expect(() => recordInBackground("tool_dispatch", overflow)).not.toThrow();
    recordInBackground("turn_run", overflow);

    expect(overflow).not.toHaveBeenCalled();
    expect(getTelemetryWriteStats()).toEqual({ inFlight: 4, dropped: 2 });

    for (const w of writes) w.resolve();
    await flush();
    // Dropped rows are gone for good: settling the slots does not replay them.
    expect(overflow).not.toHaveBeenCalled();
    expect(getTelemetryWriteStats()).toEqual({ inFlight: 0, dropped: 2 });
  });

  it("frees a slot when a write succeeds and when it fails", async () => {
    const writes = fillToCap();
    const [first, second] = [requireValue(writes[0]), requireValue(writes[1])];

    first.resolve();
    await flush();
    expect(getTelemetryWriteStats().inFlight).toBe(3);
    const next = vi.fn(() => pendingWrite().write());
    recordInBackground("inference_attempt", next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(getTelemetryWriteStats()).toEqual({ inFlight: 4, dropped: 0 });

    second.reject(new Error("db down"));
    await flush();
    expect(getTelemetryWriteStats().inFlight).toBe(3);
    expect(mockWarn).toHaveBeenCalledWith("runtime_timings.write_failed", {
      label: "inference_attempt",
      errorClass: "Error",
    });
  });

  it("frees the slot of a write that throws synchronously", () => {
    recordInBackground("turn_run", () => {
      throw new TypeError("bad");
    });
    expect(getTelemetryWriteStats()).toEqual({ inFlight: 0, dropped: 0 });
  });

  it("logs drops at most once per interval, carrying the count since the last log", async () => {
    const writes = fillToCap();
    const noop = (): Promise<void> => Promise.resolve();

    recordInBackground("inference_attempt", noop);
    expect(droppedLogs()).toEqual([
      ["runtime_timings.dropped", { dropped: 1, droppedTotal: 1, maxInFlight: 4 }],
    ]);

    nowMs += DROPPED_LOG_INTERVAL_MS - 1;
    recordInBackground("inference_attempt", noop);
    recordInBackground("inference_attempt", noop);
    expect(droppedLogs()).toHaveLength(1);

    nowMs += 1;
    recordInBackground("inference_attempt", noop);
    expect(droppedLogs()).toHaveLength(2);
    expect(droppedLogs()[1]).toEqual([
      "runtime_timings.dropped", { dropped: 3, droppedTotal: 4, maxInFlight: 4 },
    ]);

    // Drops still unreported when telemetry goes quiet are logged on the next
    // settled write once the interval has passed; no timer is involved.
    recordInBackground("inference_attempt", noop);
    expect(droppedLogs()).toHaveLength(2);
    nowMs += DROPPED_LOG_INTERVAL_MS;
    requireValue(writes[0]).resolve();
    await flush();
    expect(droppedLogs()).toHaveLength(3);
    expect(droppedLogs()[2]).toEqual([
      "runtime_timings.dropped", { dropped: 1, droppedTotal: 5, maxInFlight: 4 },
    ]);

    for (const w of writes.slice(1)) w.resolve();
    await flush();
    expect(droppedLogs()).toHaveLength(3);
  });

  it("stays silent about drops when nothing was dropped", async () => {
    const writes = fillToCap();
    nowMs += DROPPED_LOG_INTERVAL_MS * 5;
    for (const w of writes) w.resolve();
    await flush();
    expect(droppedLogs()).toHaveLength(0);
  });

  it("does not throw when the drop log itself fails", () => {
    fillToCap();
    mockWarn.mockImplementationOnce(() => { throw new Error("logger down"); });
    expect(() => recordInBackground("inference_attempt", () => Promise.resolve())).not.toThrow();
    expect(getTelemetryWriteStats().dropped).toBe(1);
  });
});
