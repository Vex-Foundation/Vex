import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  __resetPendingDeltasForTests,
  STREAM_FLUSH_MS,
  REASONING_TEXT_CAP,
  reducePreview,
  useStreamStore,
} from "../streamStore.js";
import type { StreamDeltaEvent } from "@shared/schemas/stream.js";

const SESSION = "00000000-0000-4000-8000-0000000000aa";

function ev(input: {
  readonly streamId?: string;
  readonly delta: StreamDeltaEvent["delta"];
}): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId: SESSION,
    streamId: input.streamId ?? "s1",
    sequence: 0,
    deltaType: input.delta.kind,
    delta: input.delta,
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

function reasoning(text: string, streamId?: string): StreamDeltaEvent {
  return ev({ streamId, delta: { kind: "reasoning", text } });
}

describe("reducePreview", () => {
  it("starts a preview and accumulates text (status pinned to writing)", () => {
    const a = reducePreview(undefined, ev({ delta: { kind: "text", text: "Hel" } }));
    expect(a).toMatchObject({
      streamId: "s1",
      text: "Hel",
      phase: "streaming",
      toolName: null,
      reasoningText: "",
      reasoningTokens: null,
      status: "writing",
    });
    expect(a.startedAtMs).toBeTypeOf("number");
    const b = reducePreview(a, ev({ delta: { kind: "text", text: "lo" } }));
    expect(b.text).toBe("Hello");
  });

  it("resets the ROUND-scoped fields when the streamId changes", () => {
    // A new streamId is the next ROUND of the same turn (the engine opens one
    // provider stream per round), so the answer buffer and tool name reset —
    // but see the "reasoning segments" suite: the turn-scoped state survives.
    const a = reducePreview(undefined, ev({ streamId: "s1", delta: { kind: "text", text: "old" } }));
    const b = reducePreview(a, ev({ streamId: "s2", delta: { kind: "text", text: "new" } }));
    expect(b).toMatchObject({
      streamId: "s2",
      text: "new",
      phase: "streaming",
      toolName: null,
      reasoningText: "",
      status: "writing",
    });
  });

  it("sets toolName on tool_call, defaulting to 'tool' when anonymous", () => {
    const named = reducePreview(
      undefined,
      ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "c", toolCallName: "swap" } }),
    );
    expect(named.toolName).toBe("swap");
    expect(named.status).toBe("calling");
    const anon = reducePreview(
      undefined,
      ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: null, toolCallName: null } }),
    );
    expect(anon.toolName).toBe("tool");
  });

  it("marks done and error phases", () => {
    const base = reducePreview(undefined, ev({ delta: { kind: "text", text: "x" } }));
    expect(reducePreview(base, ev({ delta: { kind: "done" } })).phase).toBe("done");
    expect(
      reducePreview(base, ev({ delta: { kind: "error", message: "Stream error", code: null } })).phase,
    ).toBe("error");
  });

  it("appends reasoning text and derives status: thinking until text pins writing", () => {
    // reasoning-first stream → "thinking"
    const a = reducePreview(undefined, reasoning("weigh "));
    expect(a.status).toBe("thinking");
    expect(a.reasoningText).toBe("weigh ");
    const b = reducePreview(a, reasoning("options"));
    expect(b.reasoningText).toBe("weigh options");
    // answer starts → "writing"...
    const c = reducePreview(b, ev({ delta: { kind: "text", text: "Answer" } }));
    expect(c.status).toBe("writing");
    // ...and a late reasoning burst must NOT flip the strip back.
    const d = reducePreview(c, reasoning(" more"));
    expect(d.status).toBe("writing");
    expect(d.reasoningText).toBe("weigh options more");
  });

  it("derives 'calling' from tool_call only while no text accumulated", () => {
    const thinking = reducePreview(undefined, reasoning("t"));
    const calling = reducePreview(
      thinking,
      ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "c", toolCallName: "swap" } }),
    );
    expect(calling.status).toBe("calling");

    const writing = reducePreview(undefined, ev({ delta: { kind: "text", text: "hi" } }));
    const stillWriting = reducePreview(
      writing,
      ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "c", toolCallName: "swap" } }),
    );
    expect(stillWriting.status).toBe("writing");
  });

  it("caps reasoningText at the newest REASONING_TEXT_CAP chars", () => {
    const full = reducePreview(undefined, reasoning("a".repeat(REASONING_TEXT_CAP)));
    const over = reducePreview(full, reasoning("XYZ"));
    expect(over.reasoningText).toHaveLength(REASONING_TEXT_CAP);
    expect(over.reasoningText.endsWith("XYZ")).toBe(true);
  });

  it("captures usage.reasoningTokens, keeping the last value when omitted", () => {
    const base = reducePreview(undefined, ev({ delta: { kind: "text", text: "hi" } }));
    const withTokens = reducePreview(
      base,
      ev({
        delta: {
          kind: "usage",
          usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, reasoningTokens: 1234 },
        },
      }),
    );
    expect(withTokens.reasoningTokens).toBe(1234);
    expect(withTokens.status).toBe("writing"); // usage keeps the previous status
    const withoutTokens = reducePreview(
      withTokens,
      ev({
        delta: {
          kind: "usage",
          usage: { promptTokens: 2, completionTokens: 2, totalTokens: 4 },
        },
      }),
    );
    expect(withoutTokens.reasoningTokens).toBe(1234);
  });
});

describe("useStreamStore actions", () => {
  beforeEach(() => {
    __resetPendingDeltasForTests();
    useStreamStore.setState({ bySessionId: {} });
  });
  afterEach(() => {
    __resetPendingDeltasForTests();
    vi.useRealTimers();
  });

  it("applyDelta writes per session; clear removes only that session", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "hi" } }));
    store.applyDelta("other", ev({ delta: { kind: "text", text: "yo" } }));
    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION]?.text).toBe("hi");

    useStreamStore.getState().clear(SESSION);
    expect(useStreamStore.getState().bySessionId[SESSION]).toBeUndefined();
    expect(useStreamStore.getState().bySessionId["other"]?.text).toBe("yo");
  });

  it("clear is a no-op for an unknown session (stable state)", () => {
    const before = useStreamStore.getState().bySessionId;
    useStreamStore.getState().clear("nope");
    expect(useStreamStore.getState().bySessionId).toBe(before);
  });

  it("coalesces reasoning deltas into one state write per flush window", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, reasoning("tok1 "));
    store.applyDelta(SESSION, reasoning("tok2 "));
    store.applyDelta(SESSION, reasoning("tok3"));
    // No state write until the window elapses.
    expect(useStreamStore.getState().bySessionId[SESSION]).toBeUndefined();

    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    const preview = useStreamStore.getState().bySessionId[SESSION];
    expect(preview?.reasoningText).toBe("tok1 tok2 tok3");
    expect(preview?.status).toBe("thinking");
  });

  /**
   * THE ONE COALESCING PATH (owner decree 2026-08-03). Text used to write per
   * token while reasoning batched — two mechanisms for one job. These pin the
   * single one: both kinds wait for the same window, milestone deltas flush it
   * synchronously, and nothing reorders or is lost on the way.
   */
  it("coalesces ANSWER TEXT on the same window as reasoning", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "Hel" } }));
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "lo" } }));
    // No per-token state write — this is the asymmetry that is gone.
    expect(useStreamStore.getState().bySessionId[SESSION]).toBeUndefined();

    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION]?.text).toBe("Hello");
  });

  it("preserves the ARRIVAL ORDER of interleaved reasoning and text deltas", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, reasoning("weigh "));
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "An" } }));
    store.applyDelta(SESSION, reasoning("options"));
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "swer" } }));

    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    const preview = useStreamStore.getState().bySessionId[SESSION];
    expect(preview?.reasoningText).toBe("weigh options");
    expect(preview?.text).toBe("Answer");
    // Text arrived before the last reasoning burst, so "writing" is pinned —
    // only replay in arrival order can produce this.
    expect(preview?.status).toBe("writing");
  });

  it("flushes the queue SYNCHRONOUSLY on a tool_call milestone", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, reasoning("trace"));
    store.applyDelta(
      SESSION,
      ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "c", toolCallName: "swap" } }),
    );
    // Visible in the same tick, with the trace settled BEFORE the call.
    const preview = useStreamStore.getState().bySessionId[SESSION];
    expect(preview?.reasoningSegments).toEqual(["trace"]);
    expect(preview?.toolName).toBe("swap");
    expect(preview?.status).toBe("calling");
    // The window timer was cancelled — advancing must not double-append.
    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION]?.reasoningSegments).toEqual(["trace"]);
  });

  it("flushes the tail synchronously when the stream finalizes (done)", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "tail" } }));
    store.applyDelta(SESSION, reasoning("last thought"));
    store.applyDelta(SESSION, ev({ delta: { kind: "done" } }));

    const preview = useStreamStore.getState().bySessionId[SESSION];
    expect(preview?.text).toBe("tail");
    expect(preview?.reasoningText).toBe("last thought");
    expect(preview?.phase).toBe("done");
  });

  it("flushes the tail synchronously on abort and on error", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "partial" } }));
    store.applyDelta(SESSION, ev({ delta: { kind: "aborted" } }));
    expect(useStreamStore.getState().bySessionId[SESSION]?.text).toBe("partial");
    expect(useStreamStore.getState().bySessionId[SESSION]?.phase).toBe("done");

    store.clear(SESSION);
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "cut off" } }));
    store.applyDelta(
      SESSION,
      ev({ delta: { kind: "error", message: "Stream error", code: null } }),
    );
    expect(useStreamStore.getState().bySessionId[SESSION]?.text).toBe("cut off");
    expect(useStreamStore.getState().bySessionId[SESSION]?.phase).toBe("error");
  });

  it("settleRound flushes the queued tail into the closing round", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, reasoning("thought before the boundary"));
    store.settleRound(SESSION);
    // The trace settled into THIS round's segment, not the next one's buffer.
    const preview = useStreamStore.getState().bySessionId[SESSION];
    expect(preview?.reasoningSegments).toEqual(["thought before the boundary"]);
    expect(preview?.reasoningText).toBe("");
    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION]?.reasoningSegments).toEqual([
      "thought before the boundary",
    ]);
  });

  it("clear cancels a pending flush (no orphan timer write)", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, reasoning("trace"));
    store.clear(SESSION);
    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION]).toBeUndefined();
  });

  it("drops a stale buffer when a new stream's reasoning supersedes it", () => {
    vi.useFakeTimers();
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, reasoning("old-stream", "s1"));
    store.applyDelta(SESSION, reasoning("new-stream", "s2"));
    vi.advanceTimersByTime(STREAM_FLUSH_MS + 1);
    const preview = useStreamStore.getState().bySessionId[SESSION];
    expect(preview?.streamId).toBe("s2");
    expect(preview?.reasoningText).toBe("new-stream");
  });
});

/**
 * SEGMENTED REASONING (owner decree 2026-07-30). A turn thinks, calls a tool,
 * then thinks again — and the second burst is a NEW thought, not a
 * continuation of the first. The store therefore keeps an ordered list of
 * SETTLED segments plus the one ACTIVE buffer, so the UI can stream the
 * active one inline and stack the settled ones as expandable stamps.
 */
describe("reasoning segments", () => {
  beforeEach(() => {
    __resetPendingDeltasForTests();
    useStreamStore.setState({ bySessionId: {} });
  });
  afterEach(__resetPendingDeltasForTests);

  it("a tool_call SETTLES the active segment and empties the live buffer", () => {
    const a = reducePreview(undefined, reasoning("weighing the route"));
    expect(a.reasoningSegments).toEqual([]);
    expect(a.reasoningText).toBe("weighing the route");

    const b = reducePreview(a, ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-swap_quote", toolCallName: "swap_quote" } }));
    expect(b.reasoningSegments).toEqual(["weighing the route"]);
    expect(b.reasoningText).toBe("");
    expect(b.status).toBe("calling");
  });

  it("a reasoning delta with no active segment OPENS a new one after a tool call", () => {
    const a = reducePreview(undefined, reasoning("first thought"));
    const b = reducePreview(a, ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-swap_quote", toolCallName: "swap_quote" } }));
    const c = reducePreview(b, reasoning("second thought"));
    expect(c.reasoningSegments).toEqual(["first thought"]);
    expect(c.reasoningText).toBe("second thought");
    expect(c.status).toBe("thinking");
  });

  it("a tool_call with NO active segment settles nothing (no empty stamps)", () => {
    const a = reducePreview(undefined, ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-a", toolCallName: "a" } }));
    const b = reducePreview(a, ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-b", toolCallName: "b" } }));
    expect(b.reasoningSegments).toEqual([]);
  });

  it("a NEW streamId in the same turn KEEPS settled segments and settles the active one", () => {
    // The next provider round after a tool batch arrives under a fresh
    // streamId. It is the SAME turn, so the thinking so far must survive; only
    // the answer buffer, the tool name and the active segment reset.
    const a = reducePreview(undefined, reasoning("round one", "s1"));
    const withText = reducePreview(a, ev({ streamId: "s1", delta: { kind: "text", text: "partial" } }));
    const b = reducePreview(withText, reasoning("round two", "s2"));

    expect(b.streamId).toBe("s2");
    expect(b.reasoningSegments).toEqual(["round one"]);
    expect(b.reasoningText).toBe("round two");
    expect(b.text).toBe("");
    expect(b.toolName).toBeNull();
    // The turn clock is the TURN's, not the round's — the elapsed counter must
    // not restart every time the provider opens a new stream.
    expect(b.startedAtMs).toBe(a.startedAtMs);
  });

  it("caps each segment independently at REASONING_TEXT_CAP", () => {
    const a = reducePreview(undefined, reasoning("a".repeat(REASONING_TEXT_CAP + 100)));
    const b = reducePreview(a, ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-t", toolCallName: "t" } }));
    const c = reducePreview(b, reasoning("b".repeat(REASONING_TEXT_CAP + 100)));
    expect(b.reasoningSegments[0]?.length).toBe(REASONING_TEXT_CAP);
    expect(c.reasoningText.length).toBe(REASONING_TEXT_CAP);
  });

  it("settleRound closes the round without discarding the turn's thinking", () => {
    const store = useStreamStore.getState();
    store.applyDelta(SESSION, ev({ delta: { kind: "text", text: "before the call" } }));
    store.applyDelta(SESSION, ev({ delta: { kind: "tool_call", toolCallIndex: 0, toolCallId: "call-swap_quote", toolCallName: "swap_quote" } }));
    store.settleRound(SESSION);

    const preview = useStreamStore.getState().bySessionId[SESSION];
    // The prose the round wrote is now a PERSISTED row, so the preview must
    // stop rendering its copy — but the preview itself survives, because the
    // turn has not ended.
    expect(preview).toBeDefined();
    expect(preview?.text).toBe("");
    expect(preview?.toolName).toBeNull();
    expect(preview?.status).toBe("working");
    expect(preview?.phase).toBe("streaming");
  });

  it("settleRound is a no-op for a session with no preview", () => {
    const before = useStreamStore.getState().bySessionId;
    useStreamStore.getState().settleRound("nope");
    expect(useStreamStore.getState().bySessionId).toBe(before);
  });
});
