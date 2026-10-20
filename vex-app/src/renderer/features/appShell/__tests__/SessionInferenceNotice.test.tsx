/**
 * The D16 notice on the turn: retained per session from the engine event,
 * shown as a fill plus a word with the figures, dismissible, and bounded.
 */

import type { JSX } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InferenceNoticeEvent } from "@shared/schemas/inference-notice.js";
import { useInferenceNoticeRetentionSync } from "../../../lib/api/inference-notices.js";
import { MAX_SESSIONS, useInferenceNoticeStore } from "../../../stores/inferenceNoticeStore.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";
import { SessionInferenceNotice } from "../SessionInferenceNotice.js";

const SESSION = "3f0d2f7a-1c2b-4b3c-8d4e-5f6a7b8c9d0e";

function notice(overrides: Partial<InferenceNoticeEvent> = {}): InferenceNoticeEvent {
  return {
    type: "engine.inference.notice",
    kind: "max_tokens_clamped",
    sessionId: SESSION,
    missionRunId: null,
    provider: "vexcloud",
    model: "anthropic/claude-haiku-5.5",
    requested: 16_384,
    effective: 4_096,
    reason: "balance",
    occurredAt: "2026-10-20T12:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  useInferenceNoticeStore.setState({ bySessionId: {} });
});

afterEach(() => {
  cleanup();
});

describe("SessionInferenceNotice", () => {
  it("renders nothing without a notice", () => {
    const { container } = render(<SessionInferenceNotice sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
  });

  it("a balance clamp says so with the figures and the next step", () => {
    act(() => useInferenceNoticeStore.getState().record(notice()));
    render(<SessionInferenceNotice sessionId={SESSION} />);
    const status = screen.getByRole("status");
    expect(status.getAttribute("data-vex-inference-notice")).toBe("balance");
    expect(status.textContent).toContain("Answer limit lowered");
    expect(status.textContent).toContain("4,096 of 16,384 tokens");
    expect(status.textContent).toContain("Top up VEX");
  });

  it("a model-limit clamp has no top-up advice", () => {
    act(() => useInferenceNoticeStore.getState().record(notice({ reason: "model_limit", requested: 200_000, effective: 65_536 })));
    render(<SessionInferenceNotice sessionId={SESSION} />);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("Answer limit capped");
    expect(status.textContent).not.toContain("Top up");
  });

  it("is per session and dismissible", () => {
    act(() => useInferenceNoticeStore.getState().record(notice({ sessionId: "other-session" })));
    const { container } = render(<SessionInferenceNotice sessionId={SESSION} />);
    expect(container.firstChild).toBeNull();
    act(() => useInferenceNoticeStore.getState().record(notice()));
    fireEvent.click(screen.getByRole("button", { name: "Dismiss the answer limit notice" }));
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("the store is bounded: the oldest session's notice is evicted first", () => {
    act(() => {
      for (let i = 0; i < MAX_SESSIONS + 5; i += 1) useInferenceNoticeStore.getState().record(notice({ sessionId: `s-${i}` }));
    });
    const ids = Object.keys(useInferenceNoticeStore.getState().bySessionId);
    expect(ids).toHaveLength(MAX_SESSIONS);
    expect(ids).not.toContain("s-0");
    expect(ids).toContain(`s-${MAX_SESSIONS + 4}`);
  });
});

describe("from the engine event to the turn", () => {
  it("the shell's retention sync records the pushed notice and the turn shows it", () => {
    let push: ((event: InferenceNoticeEvent) => void) | null = null;
    let unsubscribed = false;
    Object.defineProperty(window, "vex", {
      configurable: true,
      value: {
        engine: makeEngineBridgeStub({
          onInferenceNotice: (cb) => {
            push = cb;
            return () => {
              unsubscribed = true;
            };
          },
        }),
      },
    });
    function Shell(): JSX.Element {
      useInferenceNoticeRetentionSync();
      return <SessionInferenceNotice sessionId={SESSION} />;
    }
    const { unmount } = render(<Shell />);
    expect(screen.queryByRole("status")).toBeNull();
    act(() => push?.(notice()));
    expect(screen.getByRole("status").textContent).toContain("4,096 of 16,384 tokens");
    unmount();
    expect(unsubscribed).toBe(true);
  });
});
