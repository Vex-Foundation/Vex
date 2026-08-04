import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock surfaces BEFORE importing the bridge so the module wires its
// subscription against our stubs.
const broadcastMock = vi.fn();
vi.mock("../../lifecycle/broadcast.js", () => ({
  broadcastToAllWindows: (...args: unknown[]) => broadcastMock(...args),
}));

const logWarn = vi.fn();
vi.mock("../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    warn: (...args: unknown[]) => logWarn(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

// The engine bus is a real module — using the singleton verifies the
// "import directly from stream-bus.js" constraint at runtime.
const { streamDeltaBus, STREAM_DELTA_EVENT_TYPE } = await import(
  "@vex-agent/engine/events/stream-bus.js"
);
const { setupStreamBridge } = await import("../stream-bridge.js");
const { EV } = await import("@shared/ipc/channels.js");

const SESSION = "00000000-0000-4000-8000-000000000001";

function baseEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: STREAM_DELTA_EVENT_TYPE,
    sessionId: SESSION,
    streamId: "stream-1",
    sequence: 0,
    deltaType: "text",
    delta: { kind: "text", text: "hi" },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
    ...overrides,
  };
}

function lastBroadcast(): { deltaType: string; delta: Record<string, unknown> } {
  const call = broadcastMock.mock.calls[0]!;
  return call[1] as { deltaType: string; delta: Record<string, unknown> };
}

describe("stream bridge", () => {
  beforeEach(() => {
    broadcastMock.mockReset();
    logWarn.mockReset();
    streamDeltaBus.clear();
  });

  it("broadcasts a sanitized text delta on EV.engine.streamDelta", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(baseEvent() as never);
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock.mock.calls[0]![0]).toBe(EV.engine.streamDelta);
      expect(lastBroadcast()).toMatchObject({
        deltaType: "text",
        delta: { kind: "text", text: "hi" },
      });
      expect(logWarn).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it("broadcasts a reasoning delta unchanged (live working-strip feed)", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({
          deltaType: "reasoning",
          delta: { kind: "reasoning", text: "weighing the options" },
        }) as never,
      );
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      expect(broadcastMock.mock.calls[0]![0]).toBe(EV.engine.streamDelta);
      expect(lastBroadcast()).toMatchObject({
        deltaType: "reasoning",
        delta: { kind: "reasoning", text: "weighing the options" },
      });
      expect(logWarn).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it("drops the raw argsDelta from tool_call deltas (sanitization-by-omission)", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({
          deltaType: "tool_call",
          delta: {
            kind: "tool_call",
            toolCallIndex: 0,
            toolCallId: "call-1",
            toolCallName: "transfer",
            argsDelta: '{"to":"0xSECRETADDRESS","amount":"999"}',
          },
        }) as never,
      );
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      const payload = lastBroadcast();
      expect(payload.delta).toEqual({
        kind: "tool_call",
        toolCallIndex: 0,
        toolCallId: "call-1",
        toolCallName: "transfer",
      });
      const serialized = JSON.stringify(payload);
      expect(serialized).not.toContain("argsDelta");
      expect(serialized).not.toContain("0xSECRETADDRESS");
    } finally {
      teardown();
    }
  });

  it.each([
    ["trench__launch_execute", "trench.launch_execute"],
    ["dexscreener__tokenPairs", "dexscreener.tokenPairs"],
    // Unresolvable: the live island must show the raw name, never borrow a venue.
    ["kyberswapp__swap__quote", "kyberswapp__swap__quote"],
    // Internal tools are untouched.
    ["agent_scan", "agent_scan"],
  ])("canonicalizes the live tool-call name %s to %s", (wire, expected) => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({
          deltaType: "tool_call",
          delta: {
            kind: "tool_call",
            toolCallIndex: 0,
            toolCallId: "call-1",
            toolCallName: wire,
          },
        }) as never,
      );
      expect(lastBroadcast().delta["toolCallName"]).toBe(expected);
    } finally {
      teardown();
    }
  });

  it("keeps a null tool-call name null", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({
          deltaType: "tool_call",
          delta: {
            kind: "tool_call",
            toolCallIndex: 0,
            toolCallId: "call-1",
            toolCallName: null,
          },
        }) as never,
      );
      expect(lastBroadcast().delta["toolCallName"]).toBeNull();
    } finally {
      teardown();
    }
  });

  it("replaces raw provider error text with a safe generic, keeping code", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({
          deltaType: "error",
          delta: { kind: "error", message: "FAKE_SECRET_sk-abc123 rate limited", code: 429 },
        }) as never,
      );
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      const payload = lastBroadcast();
      expect(payload.delta).toEqual({
        kind: "error",
        message: "Stream error",
        code: 429,
        // Bounded enum label now crosses beside the code; `null` when the
        // provider reported no type. The generic message is unchanged.
        errorType: null,
      });
      expect(JSON.stringify(payload)).not.toContain("FAKE_SECRET");
    } finally {
      teardown();
    }
  });

  it("strips the authoritative cost from usage deltas (renderer schema is strict)", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({
          deltaType: "usage",
          delta: {
            kind: "usage",
            usage: {
              promptTokens: 100,
              completionTokens: 50,
              totalTokens: 150,
              cachedTokens: 20,
              reasoningTokens: 10,
              cost: 0.0123,
            },
          },
        }) as never,
      );
      expect(broadcastMock).toHaveBeenCalledTimes(1);
      const payload = lastBroadcast();
      // Only the 5 renderer-known token fields survive; cost is dropped so the
      // strict renderer schema accepts the delta (and cost never leaks to UI).
      expect(payload.delta).toEqual({
        kind: "usage",
        usage: {
          promptTokens: 100,
          completionTokens: 50,
          totalTokens: 150,
          cachedTokens: 20,
          reasoningTokens: 10,
        },
      });
      expect(JSON.stringify(payload)).not.toContain("cost");
      expect(logWarn).not.toHaveBeenCalled();
    } finally {
      teardown();
    }
  });

  it("drops + logs a payload that fails strict validation (bad sessionId)", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(baseEvent({ sessionId: "not-a-uuid" }) as never);
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn.mock.calls[0]?.[0]).toContain(
        "dropped invalid engine.streamDelta payload",
      );
    } finally {
      teardown();
    }
  });

  it("drops + logs without crashing on a malformed engine event (no delta)", () => {
    const teardown = setupStreamBridge();
    try {
      expect(() => streamDeltaBus.emit({ foo: "bar" } as never)).not.toThrow();
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledTimes(1);
      expect(logWarn.mock.calls[0]?.[0]).toContain("unmappable");
    } finally {
      teardown();
    }
  });

  it("drops an unknown delta kind (fail-closed)", () => {
    const teardown = setupStreamBridge();
    try {
      streamDeltaBus.emit(
        baseEvent({ deltaType: "bogus", delta: { kind: "bogus" } }) as never,
      );
      expect(broadcastMock).not.toHaveBeenCalled();
      expect(logWarn).toHaveBeenCalledTimes(1);
    } finally {
      teardown();
    }
  });

  it("teardown unsubscribes the bridge from the bus", () => {
    const teardown = setupStreamBridge();
    expect(streamDeltaBus.size()).toBe(1);
    teardown();
    expect(streamDeltaBus.size()).toBe(0);

    streamDeltaBus.emit(baseEvent() as never);
    expect(broadcastMock).not.toHaveBeenCalled();
  });
});
