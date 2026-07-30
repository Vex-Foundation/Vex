import { describe, expect, it, vi } from "vitest";

import {
  STREAM_DELTA_EVENT_TYPE,
  StreamDeltaBus,
  streamDeltaBus,
  toStreamDeltaEvent,
  type StreamDeltaEvent,
} from "../../../../vex-agent/engine/events/stream-bus.js";
import type { StreamChunk } from "../../../../vex-agent/inference/types.js";

function sampleEvent(overrides: Partial<StreamDeltaEvent> = {}): StreamDeltaEvent {
  return {
    type: STREAM_DELTA_EVENT_TYPE,
    sessionId: "00000000-0000-4000-8000-000000000001",
    streamId: "stream-1",
    sequence: 0,
    deltaType: "text",
    delta: { kind: "text", text: "hi" },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
    ...overrides,
  };
}

describe("stream delta bus", () => {
  it("delivers emit() to every subscriber", () => {
    const bus = new StreamDeltaBus();
    const a = vi.fn();
    const b = vi.fn();
    bus.subscribe(a);
    bus.subscribe(b);

    const event = sampleEvent();
    bus.emit(event);

    expect(a).toHaveBeenCalledTimes(1);
    expect(a).toHaveBeenCalledWith(event);
    expect(b).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledWith(event);
  });

  it("subscribe returns an idempotent unsubscribe", () => {
    const bus = new StreamDeltaBus();
    const listener = vi.fn();
    const off = bus.subscribe(listener);

    off();
    off(); // idempotent — must not throw, must not re-add
    bus.emit(sampleEvent());

    expect(listener).not.toHaveBeenCalled();
    expect(bus.size()).toBe(0);
  });

  it("isolates a misbehaving listener from the rest of the bus", () => {
    const bus = new StreamDeltaBus();
    const angry = vi.fn(() => {
      throw new Error("poison");
    });
    const calm = vi.fn();

    bus.subscribe(angry);
    bus.subscribe(calm);

    expect(() => bus.emit(sampleEvent())).not.toThrow();
    expect(angry).toHaveBeenCalledTimes(1);
    expect(calm).toHaveBeenCalledTimes(1);
  });

  it("size() reflects active subscriptions; clear() empties the bus", () => {
    const bus = new StreamDeltaBus();
    expect(bus.size()).toBe(0);
    bus.subscribe(() => {});
    bus.subscribe(() => {});
    expect(bus.size()).toBe(2);
    bus.clear();
    expect(bus.size()).toBe(0);
  });

  it("singleton streamDeltaBus is a StreamDeltaBus instance", () => {
    expect(streamDeltaBus).toBeInstanceOf(StreamDeltaBus);
  });
});

describe("toStreamDeltaEvent", () => {
  const SESSION = "00000000-0000-4000-8000-0000000000aa";

  it("sets the envelope fields and keeps deltaType in sync with delta.kind", () => {
    const event = toStreamDeltaEvent(SESSION, "stream-7", 3, {
      type: "content",
      text: "tok",
    });
    expect(event.type).toBe(STREAM_DELTA_EVENT_TYPE);
    expect(event.sessionId).toBe(SESSION);
    expect(event.streamId).toBe("stream-7");
    expect(event.sequence).toBe(3);
    expect(event.correlationId).toBeNull();
    expect(typeof event.createdAt).toBe("string");
    expect(event.deltaType).toBe(event.delta.kind);
  });

  it("maps a content chunk to a text delta", () => {
    const event = toStreamDeltaEvent(SESSION, "s", 0, { type: "content", text: "abc" });
    expect(event.deltaType).toBe("text");
    expect(event.delta).toEqual({ kind: "text", text: "abc" });
  });

  it("maps a tool_call_delta chunk, defaulting absent fields to null", () => {
    const full = toStreamDeltaEvent(SESSION, "s", 0, {
      type: "tool_call_delta",
      toolCallIndex: 2,
      toolCallId: "call-1",
      toolCallName: "transfer",
      toolCallArgsDelta: '{"to":',
    });
    expect(full.deltaType).toBe("tool_call");
    expect(full.delta).toEqual({
      kind: "tool_call",
      toolCallIndex: 2,
      toolCallId: "call-1",
      toolCallName: "transfer",
      argsDelta: '{"to":',
    });

    const partial = toStreamDeltaEvent(SESSION, "s", 1, {
      type: "tool_call_delta",
      toolCallIndex: 0,
    });
    expect(partial.delta).toEqual({
      kind: "tool_call",
      toolCallIndex: 0,
      toolCallId: null,
      toolCallName: null,
      argsDelta: null,
    });
  });

  it("maps reasoning, usage, done and error chunks", () => {
    expect(toStreamDeltaEvent(SESSION, "s", 0, { type: "reasoning", reasoningText: "why" }).delta).toEqual({
      kind: "reasoning",
      text: "why",
    });

    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    expect(toStreamDeltaEvent(SESSION, "s", 0, { type: "usage", usage }).delta).toEqual({
      kind: "usage",
      usage,
    });

    expect(toStreamDeltaEvent(SESSION, "s", 0, { type: "done" }).delta).toEqual({ kind: "done" });

    expect(
      toStreamDeltaEvent(SESSION, "s", 0, {
        type: "error",
        errorMessage: "rate limited",
        errorCode: 429,
      }).delta,
    ).toEqual({
      kind: "error",
      message: "rate limited",
      code: 429,
      // The provider reported no `metadata.errorType` on this chunk. `null`,
      // not absent: the field exists on every error delta so consumers never
      // have to distinguish "no type" from "field not plumbed".
      errorType: null,
    });
  });

  it("falls back to safe defaults for an error chunk missing fields", () => {
    const event = toStreamDeltaEvent(SESSION, "s", 0, { type: "error" } as StreamChunk);
    expect(event.delta).toEqual({
      kind: "error",
      message: "stream error",
      code: null,
      errorType: null,
    });
  });
});
