/**
 * `useTurnPreview` — the turn-scoped preview AND the centred scene's latch.
 *
 * The latch is the load-bearing part and it has been got wrong twice before
 * (once by inferring "nothing on screen" from the preview's CONTENT, once from
 * a provider-round count). Both failures had the same shape: a proxy standing
 * in for the viewport. The rule this suite pins is the third and narrowest
 * answer — the scene may open only once a VIEWPORT-SAFE LIVE USER ANCHOR is in
 * the transcript: a row newer than the send-time baseline, of the `user`
 * variant, appended live. That is deliberately NOT a claim that the row belongs
 * to "this send" — the renderer holds no turn correlation id and must never
 * pretend otherwise. It is a claim the renderer can actually witness: the
 * viewport has just been re-anchored onto a fresh user row, so a centred scene
 * covers nothing the reader is reading.
 */

import { describe, expect, it } from "vitest";
import { StrictMode } from "react";
import { renderHook } from "@testing-library/react";
import type { StreamPreview } from "../../../../stores/streamStore.js";
import {
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
    status: "working",
    ...over,
  };
}

function input(over: Partial<TurnPreviewInput> = {}): TurnPreviewInput {
  return {
    sessionId: SESSION_A,
    preview: null,
    submitting: false,
    newestId: 10,
    newestVariant: "assistant",
    newestIsLiveAppend: false,
    ...over,
  };
}

/** The live user row this send re-anchors the viewport onto. */
function userAnchor(over: Partial<TurnPreviewInput> = {}): TurnPreviewInput {
  return input({
    submitting: true,
    newestId: 11,
    newestVariant: "user",
    newestIsLiveAppend: true,
    ...over,
  });
}

describe("useTurnPreview — the centred scene latch", () => {
  it("stays OFF at the send edge while the OLD transcript is still rendered", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    expect(result.current.centredSceneEligible).toBe(false);

    // submitting flips before main has appended the user row — the scroller
    // still shows the previous conversation.
    rerender(input({ submitting: true }));
    expect(result.current.centredSceneEligible).toBe(false);
    // And it must stay off across re-renders that change nothing.
    rerender(input({ submitting: true }));
    expect(result.current.centredSceneEligible).toBe(false);
  });

  it("opens once the live user row lands", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    rerender(userAnchor());
    expect(result.current.centredSceneEligible).toBe(true);
  });

  it("closes PERMANENTLY on the first real engine preview", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    rerender(userAnchor());
    expect(result.current.centredSceneEligible).toBe(true);

    rerender(userAnchor({ preview: livePreview({ status: "thinking" }) }));
    expect(result.current.centredSceneEligible).toBe(false);

    // The store clearing (idle timer, abort, session cleanup) must NOT reopen
    // it while the same submission is still running.
    rerender(userAnchor({ preview: null }));
    expect(result.current.centredSceneEligible).toBe(false);
  });

  it("closes PERMANENTLY when a non-user row lands with no preview ever observed", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    rerender(userAnchor());
    expect(result.current.centredSceneEligible).toBe(true);

    // Preview delivery is best-effort; a persisted tool/assistant row is the
    // evidence that does not depend on ever seeing one.
    rerender(
      userAnchor({ newestId: 12, newestVariant: "tool", newestIsLiveAppend: true }),
    );
    expect(result.current.centredSceneEligible).toBe(false);

    rerender(userAnchor({ newestId: 12, newestVariant: "user" }));
    expect(result.current.centredSceneEligible).toBe(false);
  });

  it("mounting straight INTO an already-submitting session is never eligible", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input({ submitting: true }),
    });
    rerender(userAnchor());
    expect(result.current.centredSceneEligible).toBe(false);
  });

  it("re-arms across false→true→false→true (retry, and Stop-then-send)", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    rerender(userAnchor());
    expect(result.current.centredSceneEligible).toBe(true);

    rerender(input({ submitting: false, newestId: 12 }));
    expect(result.current.centredSceneEligible).toBe(false);

    rerender(input({ submitting: true, newestId: 12 }));
    expect(result.current.centredSceneEligible).toBe(false);
    rerender(userAnchor({ newestId: 13 }));
    expect(result.current.centredSceneEligible).toBe(true);
  });

  it("a session switch resets the clock and both latches (fail-closed)", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input(),
    });
    rerender(input({ submitting: true }));
    rerender(userAnchor());
    const previewA = result.current.preview;
    expect(result.current.centredSceneEligible).toBe(true);

    // Switching into another session that is ALSO mid-flight: the new session's
    // send edge was never observed here, so nothing may open, and the elapsed
    // clock must not be inherited from the session we left.
    rerender(userAnchor({ sessionId: SESSION_B }));
    expect(result.current.centredSceneEligible).toBe(false);
    expect(result.current.preview).not.toBe(previewA);
  });

  it("a StrictMode double-render never produces an unsafe true", () => {
    const { result, rerender } = renderHook(useTurnPreview, {
      initialProps: input({ submitting: true }),
      wrapper: StrictMode,
    });
    expect(result.current.centredSceneEligible).toBe(false);
    rerender(userAnchor());
    expect(result.current.centredSceneEligible).toBe(false);
  });
});

describe("useTurnPreview — the turn-scoped preview itself (unchanged behaviour)", () => {
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
      phase: "streaming",
      status: "working",
      text: "",
    });
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
});
