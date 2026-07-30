/**
 * Tests for `useStreamPreviewSync` (stage 9-3):
 *  - subscribes to onStreamDelta + onTranscriptAppend on mount;
 *  - a matching delta feeds the streamStore; foreign-session deltas are ignored;
 *  - an assistant transcriptAppend clears the preview AFTER the refetch settles;
 *  - a non-assistant append does not clear;
 *  - an ABORTED delta (the Stop path) clears immediately;
 *  - an orphaned preview is cleared by the idle timeout;
 *  - unmount unsubscribes both listeners, clears the preview, and disarms timers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import { STREAM_PREVIEW_IDLE_MS, useStreamPreviewSync } from "../streams.js";
import {
  REASONING_FLUSH_MS,
  useStreamStore,
  __resetPendingReasoningForTests,
} from "../../../stores/streamStore.js";
import {
  streamDeltaEventSchema,
  type StreamDeltaEvent,
} from "@shared/schemas/stream.js";
import type { TranscriptAppendEvent } from "@shared/schemas/messages.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";

type DeltaCb = (e: StreamDeltaEvent) => void;
type AppendCb = (e: TranscriptAppendEvent) => void;

let deltaCb: DeltaCb | null;
let appendCb: AppendCb | null;
const offDelta = vi.fn();
const offAppend = vi.fn();

beforeEach(() => {
  deltaCb = null;
  appendCb = null;
  offDelta.mockReset();
  offAppend.mockReset();
  useStreamStore.setState({ bySessionId: {} });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onStreamDelta: (cb) => {
          deltaCb = cb;
          return offDelta;
        },
        onTranscriptAppend: (cb) => {
          appendCb = cb;
          return offAppend;
        },
      }),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error — test cleanup
  delete window.vex;
});

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function textDelta(sessionId: string, streamId = "s1", text = "hi"): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence: 0,
    deltaType: "text",
    delta: { kind: "text", text },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

function append(
  sessionId: string,
  role: TranscriptAppendEvent["role"] = "assistant",
): TranscriptAppendEvent {
  return {
    type: "engine.transcript.append",
    sessionId,
    messageId: 1,
    role,
    createdAt: "2026-05-26T10:00:00.000Z",
    messageType: null,
    correlationId: null,
  };
}

/**
 * The REAL emitted shape, mirroring `toStreamAbortedEvent`
 * (`engine/events/stream-bus.ts`): same `streamId` as the stream it ends, at
 * `lastSequence + 1`, `deltaType: "aborted"`, and a delta that is the bare
 * discriminant — no reason string, no provider text.
 */
function abortedDelta(
  sessionId: string,
  streamId = "s1",
  sequence = 1,
): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence,
    deltaType: "aborted",
    delta: { kind: "aborted" },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

function reasoningDelta(
  sessionId: string,
  streamId = "s1",
  text = "thinking",
  sequence = 0,
): StreamDeltaEvent {
  return {
    type: "engine.stream.delta",
    sessionId,
    streamId,
    sequence,
    deltaType: "reasoning",
    delta: { kind: "reasoning", text },
    createdAt: "2026-05-26T10:00:00.000Z",
    correlationId: null,
  };
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("useStreamPreviewSync", () => {
  it("subscribes on mount, feeds deltas, and tears down on unmount", () => {
    const { unmount } = renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    expect(deltaCb).not.toBeNull();
    expect(appendCb).not.toBeNull();

    deltaCb!(textDelta(SESSION_A));
    expect(useStreamStore.getState().bySessionId[SESSION_A]?.text).toBe("hi");

    unmount();
    expect(offDelta).toHaveBeenCalledTimes(1);
    expect(offAppend).toHaveBeenCalledTimes(1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  it("no-ops on a null sessionId", () => {
    renderHook(() => useStreamPreviewSync(null), { wrapper: makeWrapper(new QueryClient()) });
    expect(deltaCb).toBeNull();
  });

  it("ignores deltas for a different session", () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), { wrapper: makeWrapper(new QueryClient()) });
    deltaCb!(textDelta(SESSION_B));
    expect(useStreamStore.getState().bySessionId[SESSION_B]).toBeUndefined();
  });

  it("clears the preview after a matching assistant append (post-refetch)", async () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), { wrapper: makeWrapper(new QueryClient()) });
    deltaCb!(textDelta(SESSION_A));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();

    appendCb!(append(SESSION_A, "assistant"));
    await flush();
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  it("does not clear on a non-assistant append", async () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), { wrapper: makeWrapper(new QueryClient()) });
    deltaCb!(textDelta(SESSION_A));
    appendCb!(append(SESSION_A, "tool"));
    await flush();
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();
  });

  it("does not clear a newer stream when an older append's refetch settles late", async () => {
    const client = new QueryClient();
    let resolveInvalidate: (() => void) | null = null;
    vi.spyOn(client, "invalidateQueries").mockReturnValue(
      new Promise<void>((resolve) => {
        resolveInvalidate = () => resolve();
      }) as ReturnType<typeof client.invalidateQueries>,
    );
    renderHook(() => useStreamPreviewSync(SESSION_A), { wrapper: makeWrapper(client) });

    // Stream s1 previews; its assistant append fires (refetch now pending).
    deltaCb!(textDelta(SESSION_A, "s1", "first"));
    appendCb!(append(SESSION_A, "assistant"));

    // Before the refetch settles, the next turn's stream s2 begins.
    deltaCb!(textDelta(SESSION_A, "s2", "second"));
    expect(useStreamStore.getState().bySessionId[SESSION_A]?.streamId).toBe("s2");

    // s1's refetch resolves late — it must NOT clear s2's live preview.
    resolveInvalidate!();
    await flush();
    const current = useStreamStore.getState().bySessionId[SESSION_A];
    expect(current?.streamId).toBe("s2");
    expect(current?.text).toBe("second");
  });

  it("clears an errored preview IMMEDIATELY, not after the idle timer", () => {
    // Before this, an errored stream left a frozen half-written preview on
    // screen for the full 60 s while the user had no idea anything failed.
    // The failure now has its own surface (`SessionErrorBanner`).
    vi.useFakeTimers();
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    deltaCb!(textDelta(SESSION_A, "s1", "half a sen"));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();

    deltaCb!({
      type: "engine.stream.delta",
      sessionId: SESSION_A,
      streamId: "s1",
      sequence: 1,
      deltaType: "error",
      delta: { kind: "error", message: "Stream error", code: 429 },
      createdAt: "2026-05-26T10:00:00.000Z",
      correlationId: null,
    });

    // Gone NOW — zero timer advance.
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    // And the idle timer was disarmed, not merely outrun.
    vi.advanceTimersByTime(STREAM_PREVIEW_IDLE_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  it("clears an orphaned preview after the idle timeout", () => {
    vi.useFakeTimers();
    renderHook(() => useStreamPreviewSync(SESSION_A), { wrapper: makeWrapper(new QueryClient()) });
    deltaCb!(textDelta(SESSION_A));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();

    vi.advanceTimersByTime(STREAM_PREVIEW_IDLE_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });


  /**
   * The fixture is the REAL contract, not a hand-drawn one. The previous
   * attempt at this feature pinned a control event shape production never
   * emits; parsing through the shipped `.strict()` schema is what stops that
   * from happening twice.
   */
  it("uses a fixture that validates against the shipped stream schema", () => {
    const parsed = streamDeltaEventSchema.safeParse(abortedDelta(SESSION_A));
    expect(parsed.success).toBe(true);
  });

  /**
   * The Stop path, and the reason this delta had to exist at all. An abort
   * before any persistable assistant content produces NO transcript append and
   * NO error delta, so nothing but the 60 s idle timer would ever have removed
   * the half-written reasoning/tool preview the user just stopped.
   */
  it("clears the preview immediately on an aborted delta", () => {
    vi.useFakeTimers();
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    deltaCb!(textDelta(SESSION_A, "s1", "half a sen"));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();

    deltaCb!(abortedDelta(SESSION_A, "s1", 1));

    // Gone NOW — zero timer advance.
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    // And the idle timer was disarmed, not merely outrun.
    vi.advanceTimersByTime(STREAM_PREVIEW_IDLE_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  it("ignores an aborted delta from a different session", () => {
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    deltaCb!(textDelta(SESSION_A, "s1", "still going"));

    deltaCb!(abortedDelta(SESSION_B, "s9", 1));

    expect(useStreamStore.getState().bySessionId[SESSION_A]?.text).toBe(
      "still going",
    );
  });

  /**
   * RENDER POLICY (settled 2026-07-29): the banner owns persistent error
   * display; the bubble's error branch is defense-in-depth for the window
   * before the banner event arrives. So the clear is UNCONDITIONAL and does
   * not wait on the banner — what must hold is that the store reaches the
   * error phase (what the bubble would render from) and that no preview is
   * left stuck afterwards.
   *
   * The phase mapping itself is pinned in `stores/__tests__/streamStore.test.ts`
   * ("error" delta → phase "error"); the bubble's rendering of it is pinned in
   * `features/appShell/__tests__/StreamingBubble.test.tsx`. This asserts the
   * hook-level half: applied, then cleared, with nothing stranded.
   */
  it("applies the error phase and leaves no stuck preview", () => {
    vi.useFakeTimers();
    const seenPhases: Array<string | undefined> = [];
    const unsubscribe = useStreamStore.subscribe((state) => {
      seenPhases.push(state.bySessionId[SESSION_A]?.phase);
    });
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    deltaCb!(textDelta(SESSION_A, "s1", "half a sen"));

    deltaCb!({
      type: "engine.stream.delta",
      sessionId: SESSION_A,
      streamId: "s1",
      sequence: 1,
      deltaType: "error",
      delta: { kind: "error", message: "Stream error", code: 429 },
      createdAt: "2026-05-26T10:00:00.000Z",
      correlationId: null,
    });
    unsubscribe();

    // The error phase was reached — the bubble's defense-in-depth branch has
    // something to render from during the pre-banner window.
    expect(seenPhases).toContain("error");
    // And nothing is stranded afterwards.
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    vi.advanceTimersByTime(STREAM_PREVIEW_IDLE_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  /**
   * A DELAYED abort must not kill the stream that replaced it.
   *
   * The clear is session-scoped, so without a `streamId` check an `aborted`
   * delta for stream A arriving after stream B has started would wipe B's live
   * preview — the user stops one turn, starts another, and watches the new
   * one vanish mid-sentence. The engine emits the abort on A's own chain, so
   * the id is right there to correlate on.
   */
  it("ignores a stale abort for a stream that is no longer displayed", () => {
    vi.useFakeTimers();
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    // Stream A ran, then stream B took over the preview.
    deltaCb!(textDelta(SESSION_A, "s-a", "old turn"));
    deltaCb!(textDelta(SESSION_A, "s-b", "new turn"));
    expect(useStreamStore.getState().bySessionId[SESSION_A]?.streamId).toBe("s-b");

    // A's abort finally lands.
    deltaCb!(abortedDelta(SESSION_A, "s-a", 9));

    const live = useStreamStore.getState().bySessionId[SESSION_A];
    expect(live?.streamId).toBe("s-b");
    expect(live?.text).toBe("new turn");
  });

  it("still arms the idle net after a mismatched abort is ignored", () => {
    vi.useFakeTimers();
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    deltaCb!(textDelta(SESSION_A, "s-b", "new turn"));

    deltaCb!(abortedDelta(SESSION_A, "s-a", 9));

    // A no-op abort must not leave the surviving preview without its
    // orphan timer — that would trade one stuck preview for another.
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeDefined();
    vi.advanceTimersByTime(STREAM_PREVIEW_IDLE_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  /**
   * A reasoning-only stream lives entirely in the 80 ms batching buffer before
   * its first flush, so it has no `bySessionId` entry to correlate against.
   * Its own abort was therefore read as a STALE abort and ignored — and the
   * buffer then materialized a preview that nothing would ever clear except
   * the 60 s idle timer. The correlation has to see the buffer too.
   */
  it("never materializes a reasoning-only stream aborted inside the batching window", () => {
    vi.useFakeTimers();
    __resetPendingReasoningForTests();
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });

    // Buffered only — nothing in the store yet.
    deltaCb!(reasoningDelta(SESSION_A, "s-r", "thinking hard"));
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();

    // The abort for THAT stream, still inside the window.
    deltaCb!(abortedDelta(SESSION_A, "s-r", 1));

    // The buffer must have been cancelled, not merely left unflushed.
    vi.advanceTimersByTime(REASONING_FLUSH_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
    vi.advanceTimersByTime(STREAM_PREVIEW_IDLE_MS + 1);
    expect(useStreamStore.getState().bySessionId[SESSION_A]).toBeUndefined();
  });

  it("still ignores a stale abort while a reasoning stream buffers", () => {
    vi.useFakeTimers();
    __resetPendingReasoningForTests();
    renderHook(() => useStreamPreviewSync(SESSION_A), {
      wrapper: makeWrapper(new QueryClient()),
    });
    deltaCb!(reasoningDelta(SESSION_A, "s-new", "fresh trace"));

    // An older stream's abort must not cancel the NEW stream's buffer.
    deltaCb!(abortedDelta(SESSION_A, "s-old", 9));

    vi.advanceTimersByTime(REASONING_FLUSH_MS + 1);
    const live = useStreamStore.getState().bySessionId[SESSION_A];
    expect(live?.streamId).toBe("s-new");
    expect(live?.reasoningText).toBe("fresh trace");
  });
});
