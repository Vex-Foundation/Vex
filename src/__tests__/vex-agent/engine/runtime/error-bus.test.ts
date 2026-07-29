/**
 * `engineErrorBus` + the stream-bus `errorType` survival.
 *
 * Two things are pinned here:
 *  1. the bus behaves exactly like `control-bus` / `transcript-bus` — same
 *     `Set<listener>` contract, idempotent unsubscribe, and a misbehaving
 *     listener isolated so it can never poison the inference path;
 *  2. `errorType` survives the chunk -> bus delta mapping. It did not: the
 *     bus delta had no slot for it, so the only canonical error taxonomy the
 *     provider gives us was silently discarded one layer BEFORE the IPC
 *     transport the spec started at.
 */

import { describe, it, expect, vi } from "vitest";
import {
  EngineErrorBus,
  emitEngineError,
  engineErrorBus,
  ENGINE_ERROR_EVENT_TYPE,
  type EngineErrorEvent,
} from "../../../../vex-agent/engine/runtime/error-bus.js";
import { toStreamDeltaEvent } from "../../../../vex-agent/engine/events/stream-bus.js";

const SESSION = "00000000-0000-4000-8000-00000000000a";

describe("EngineErrorBus", () => {
  it("delivers to every subscriber and unsubscribes idempotently", () => {
    const bus = new EngineErrorBus();
    const a = vi.fn();
    const b = vi.fn();
    const offA = bus.subscribe(a);
    bus.subscribe(b);
    expect(bus.size()).toBe(2);

    bus.emit({
      type: ENGINE_ERROR_EVENT_TYPE,
      sessionId: SESSION,
      missionRunId: null,
      scope: "turn",
      errorType: null,
      errorClass: null,
      statusCode: 500,
      causeCode: null,
      retryAfterSeconds: null,
      occurredAt: "2026-07-29T10:00:00.000Z",
      correlationId: null,
    });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);

    offA();
    offA();
    expect(bus.size()).toBe(1);
  });

  it("isolates a throwing listener — the error path must never take down the caller", () => {
    const bus = new EngineErrorBus();
    const good = vi.fn();
    bus.subscribe(() => {
      throw new Error("bad listener");
    });
    bus.subscribe(good);

    expect(() => {
      bus.emit({
        type: ENGINE_ERROR_EVENT_TYPE,
        sessionId: SESSION,
        missionRunId: null,
        scope: "mission",
        errorType: null,
        errorClass: null,
        statusCode: null,
        causeCode: null,
        retryAfterSeconds: null,
        occurredAt: "2026-07-29T10:00:00.000Z",
        correlationId: null,
      });
    }).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
  });
});

describe("emitEngineError", () => {
  it("stamps the type and occurredAt, and defaults every optional to null", () => {
    const seen = vi.fn();
    const off = engineErrorBus.subscribe(seen);
    emitEngineError({ sessionId: SESSION, scope: "wake" });
    off();

    const event = seen.mock.calls[0]?.[0];
    expect(event.type).toBe(ENGINE_ERROR_EVENT_TYPE);
    expect(event.scope).toBe("wake");
    expect(event.missionRunId).toBeNull();
    expect(event.errorType).toBeNull();
    expect(event.errorClass).toBeNull();
    expect(event.retryAfterSeconds).toBeNull();
    expect(Number.isNaN(Date.parse(event.occurredAt))).toBe(false);
  });

  it("carries no message field — bounded codes only, by construction", () => {
    const seen = vi.fn();
    const off = engineErrorBus.subscribe(seen);
    emitEngineError({
      sessionId: SESSION,
      scope: "turn",
      errorType: "rate_limit_exceeded",
      statusCode: 429,
      retryAfterSeconds: 41,
    });
    off();

    const keys = Object.keys(seen.mock.calls[0]?.[0] ?? {});
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("errorMessage");
  });
});

describe("emitEngineError — one bad optional must not sink the event", () => {
  // The main bridge validates the whole event with a STRICT parse, so an
  // out-of-range optional used to drop the ENTIRE permanent-failure
  // notification: the user was told nothing at all instead of "this failed,
  // cause unknown". The truthful BASE notification always survives; the
  // unusable field degrades to null, which is exactly what it tells us.
  const capture = (): EngineErrorEvent[] => {
    const seen: EngineErrorEvent[] = [];
    engineErrorBus.subscribe((event) => seen.push(event));
    return seen;
  };

  it.each([0, 99, 600, 1000, 12345, -1, 4.5, Number.NaN])(
    "delivers the event with statusCode null for out-of-range status %s",
    (statusCode) => {
      const seen = capture();
      emitEngineError({ sessionId: SESSION, scope: "compact", statusCode });
      engineErrorBus.clear();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.statusCode).toBeNull();
      expect(seen[0]?.scope).toBe("compact");
    },
  );

  it.each([0, -5, 86_401, 1_000_000, 2.5])(
    "delivers the event with retryAfterSeconds null for out-of-range %s",
    (retryAfterSeconds) => {
      const seen = capture();
      emitEngineError({ sessionId: SESSION, scope: "turn", retryAfterSeconds });
      engineErrorBus.clear();

      expect(seen).toHaveLength(1);
      expect(seen[0]?.retryAfterSeconds).toBeNull();
    },
  );

  it("nulls an errorType that is not enum-shaped, keeping the event", () => {
    // `readMissionErrorSignal` only length-caps this, but the schema demands
    // lower_snake_case — the mismatch was the same whole-event-drop bug.
    const seen = capture();
    emitEngineError({
      sessionId: SESSION,
      scope: "turn",
      errorType: "Rate Limit Exceeded",
    });
    engineErrorBus.clear();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.errorType).toBeNull();
  });

  it("nulls a non-errno causeCode and a non-class-shaped errorClass", () => {
    const seen = capture();
    emitEngineError({
      sessionId: SESSION,
      scope: "turn",
      causeCode: "not an errno",
      errorClass: "not a class name",
    });
    engineErrorBus.clear();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.causeCode).toBeNull();
    expect(seen[0]?.errorClass).toBeNull();
  });

  it("passes IN-RANGE values through unchanged", () => {
    const seen = capture();
    emitEngineError({
      sessionId: SESSION,
      scope: "turn",
      statusCode: 429,
      retryAfterSeconds: 41,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      causeCode: "ECONNRESET",
    });
    engineErrorBus.clear();
    expect(seen[0]).toMatchObject({
      statusCode: 429,
      retryAfterSeconds: 41,
      errorType: "rate_limit_exceeded",
      errorClass: "TooManyRequestsResponseError",
      causeCode: "ECONNRESET",
    });
  });

  it.each([100, 599])("keeps boundary status %i", (statusCode) => {
    const seen = capture();
    emitEngineError({ sessionId: SESSION, scope: "turn", statusCode });
    engineErrorBus.clear();
    expect(seen[0]?.statusCode).toBe(statusCode);
  });

  it.each([1, 86_400])("keeps boundary retryAfterSeconds %i", (retryAfterSeconds) => {
    const seen = capture();
    emitEngineError({ sessionId: SESSION, scope: "turn", retryAfterSeconds });
    engineErrorBus.clear();
    expect(seen[0]?.retryAfterSeconds).toBe(retryAfterSeconds);
  });
});

describe("stream-bus error delta", () => {
  it("carries errorType through the chunk -> delta mapping (it used to be dropped)", () => {
    const event = toStreamDeltaEvent(SESSION, "s1", 0, {
      type: "error",
      errorMessage: "rate limited",
      errorCode: 429,
      errorType: "rate_limit_exceeded",
    });
    expect(event.delta).toEqual({
      kind: "error",
      message: "rate limited",
      code: 429,
      errorType: "rate_limit_exceeded",
    });
  });

  it("is null — not absent — when the provider reported no type", () => {
    const event = toStreamDeltaEvent(SESSION, "s1", 0, {
      type: "error",
      errorMessage: "boom",
      errorCode: 500,
    });
    expect(event.delta).toMatchObject({ kind: "error", errorType: null });
  });
});
