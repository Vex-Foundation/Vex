/**
 * `stream-bridge` — `errorType` survives the LAST drop site.
 *
 * The provider's canonical taxonomy died three times on its way to a human.
 * Two were fixed upstream (the engine bus delta, and the mission-error
 * readers); this is the third: the main bridge rebuilt the error payload
 * without the field, so the renderer preview could only ever say the literal
 * "Stream error" — the message is a safe generic BY DESIGN, which left nothing
 * to explain why the stream died.
 *
 * The invariant that must hold alongside it: raw provider text still never
 * crosses. `errorType` is an enum label from a bounded vocabulary, not prose.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: vi.fn(),
}));
vi.mock("../../logger/index.js", () => ({
  log: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import { toRendererStreamDelta } from "../stream-bridge.js";
import { streamDeltaEventSchema } from "@shared/schemas/stream.js";
import type { StreamDeltaEvent } from "@vex-agent/engine/events/stream-bus.js";

const SESSION = "00000000-0000-4000-8000-00000000000a";

function errorDelta(
  delta: Partial<Extract<StreamDeltaEvent["delta"], { kind: "error" }>>,
): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId: SESSION,
    streamId: "s1",
    sequence: 3,
    deltaType: "error",
    delta: {
      kind: "error",
      message: "raw provider text with sk-secret123",
      code: 429,
      errorType: null,
      ...delta,
    },
    createdAt: "2026-07-29T10:00:00.000Z",
    correlationId: null,
  };
}

describe("toRendererStreamDelta - aborted delta", () => {
  it("carries the terminal abort signal with its streamId intact", () => {
    // The streamId is the whole point: a consumer must clear exactly the
    // stream that ended, never a newer one that started in between.
    const mapped = toRendererStreamDelta({
      type: "engine.stream.delta",
      sessionId: SESSION,
      streamId: "s1",
      sequence: 4,
      deltaType: "aborted",
      delta: { kind: "aborted" },
      createdAt: "2026-07-29T10:00:00.000Z",
      correlationId: null,
    });
    expect(mapped?.streamId).toBe("s1");
    expect(mapped?.deltaType).toBe("aborted");
    expect(mapped?.delta).toEqual({ kind: "aborted" });
    expect(streamDeltaEventSchema.safeParse(mapped).success).toBe(true);
  });

  it("admits no extra field - the schema is strict on the discriminant", () => {
    const parsed = streamDeltaEventSchema.safeParse({
      type: "engine.stream.delta",
      sessionId: SESSION,
      streamId: "s1",
      sequence: 4,
      deltaType: "aborted",
      delta: { kind: "aborted", reason: "user asked to stop" },
      createdAt: "2026-07-29T10:00:00.000Z",
      correlationId: null,
    });
    expect(parsed.success).toBe(false);
  });
});

describe("toRendererStreamDelta - error deltas", () => {
  it("carries the bounded errorType across the boundary", () => {
    const mapped = toRendererStreamDelta(
      errorDelta({ errorType: "rate_limit_exceeded" }),
    );
    expect(mapped?.delta).toMatchObject({
      kind: "error",
      errorType: "rate_limit_exceeded",
    });
    expect(streamDeltaEventSchema.safeParse(mapped).success).toBe(true);
  });

  it("sanitizes the raw provider message - a key never crosses, prose does", () => {
    const mapped = toRendererStreamDelta(
      errorDelta({ errorType: "rate_limit_exceeded" }),
    );
    expect(JSON.stringify(mapped)).not.toContain("sk-secret123");
  });

  it("maps a missing errorType to null, not absent", () => {
    const mapped = toRendererStreamDelta(errorDelta({ errorType: null }));
    expect(mapped?.delta).toMatchObject({ kind: "error", errorType: null });
    expect(streamDeltaEventSchema.safeParse(mapped).success).toBe(true);
  });

  it("rejects a label that is not enum-shaped - the bound is real", () => {
    const mapped = toRendererStreamDelta(
      errorDelta({ errorType: "Not An Enum Label, But A Sentence." }),
    );
    // The mapper forwards what the engine gave it; the strict schema is what
    // refuses it, so the bridge drops the delta rather than smuggling prose
    // through a field that is supposed to hold a vocabulary member.
    expect(streamDeltaEventSchema.safeParse(mapped).success).toBe(false);
  });
});
