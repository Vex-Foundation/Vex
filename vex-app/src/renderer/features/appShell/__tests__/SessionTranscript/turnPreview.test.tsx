/**
 * `useTurnPreview` - the turn-scoped preview.
 *
 * What this hook must guarantee, now that the centred scene and its
 * transcript-evidence latch are retired (round 3): a turn that has been sent
 * but has not spoken yet still has a VISIBLE surface, and the elapsed clock
 * measures the TURN rather than the provider round the engine happens to be
 * in. The synthetic placeholder is what the in-flow `vexing…` pill renders
 * from before the first engine delta, so losing it would restore the ghost
 * moment the hook exists to kill.
 */

import { describe, expect, it } from "vitest";
import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import type { StreamPreview } from "../../../../stores/streamStore.js";
import {
  PENDING_TURN_STREAM_ID,
  useTurnPreview,
  type TurnPreviewInput,
} from "../../SessionTranscript/turnPreview.js";

const SESSION_A = "session-a";
const SESSION_B = "session-b";

function livePreview(over: Partial<StreamPreview> = {}): StreamPreview {
  return {
    streamId: "s1",
    text: "",
    phase: "streaming",
    toolName: null,
    reasoningSegments: [],
    reasoningText: "",
    reasoningTokens: null,
    startedAtMs: Date.now(),
    errorType: null,
    errorDetail: null,
    status: "working",
    ...over,
  };
}

function input(over: Partial<TurnPreviewInput> = {}): TurnPreviewInput {
  return {
    sessionId: SESSION_A,
    preview: null,
    submitting: false,
    ...over,
  };
}

describe("useTurnPreview - the turn-scoped preview", () => {
  it("returns null when no turn is in flight", () => {
    const { result } = renderHook(useTurnPreview, { initialProps: input() });
    expect(result.current.preview).toBeNull();
  });

  it("synthesises a working placeholder from the send until the first delta", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    expect(result.current.preview).toMatchObject({
      streamId: PENDING_TURN_STREAM_ID,
      phase: "streaming",
      status: "working",
      text: "",
    });
  });

  it("keeps ONE placeholder identity across renders of the same turn", () => {
    // The in-flow pill and the answer body memoize on the preview object; a
    // fresh placeholder per render would churn them for the whole silent leg.
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    const first = result.current.preview;
    rerender(input({ submitting: true }));
    expect(result.current.preview).toBe(first);
  });

  it("a real preview wins, but keeps the TURN's start time", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    const turnStart = result.current.preview?.startedAtMs ?? 0;
    rerender(
      input({
        submitting: true,
        preview: livePreview({ startedAtMs: turnStart + 5_000, text: "hi" }),
      }),
    );
    expect(result.current.preview?.text).toBe("hi");
    expect(result.current.preview?.startedAtMs).toBe(turnStart);
  });

  it("retires the placeholder the moment the turn settles", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input({ submitting: true }),
    });
    expect(result.current.preview).not.toBeNull();
    rerender(input({ submitting: false }));
    expect(result.current.preview).toBeNull();
  });

  it("a session switch never inherits the other session's turn clock", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input({ submitting: true }),
    });
    const previewA = result.current.preview;
    rerender(input({ sessionId: SESSION_B, submitting: true }));
    expect(result.current.preview).not.toBe(previewA);
  });

  it("survives a StrictMode double-render with one stable placeholder", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input({ submitting: true }),
      wrapper: StrictMode,
    });
    const first = result.current.preview;
    expect(first).not.toBeNull();
    rerender(input({ submitting: true }));
    expect(result.current.preview).toBe(first);
  });
});
