/**
 * A33 — a submit while a turn is in flight STEERS the live turn; the A27
 * queue is the fallback, never the first resort. Pinned laws: `queued_live`
 * means the text is on the tape, so it must NOT also queue (double-send);
 * `no_active_turn` and a steer failure both fall back to the queue (never
 * dropped); an idle-session submit never touches the steer channel; the
 * steered row wears its delivery words in the transcript.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, render, renderHook, waitFor } from "@testing-library/react";
import { createElement, type FormEvent, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readQueue, resetComposerQueueForTest } from "../../../lib/composer-queue.js";
import { resetDraftsForTest } from "../../../lib/composer-drafts.js";
import { getToastSnapshot } from "../../../lib/toast.js";
import { TranscriptMessage } from "../TranscriptMessage.js";

const mockSteer = vi.fn();
const mockMutateAsync = vi.fn();
const mockUseRuntimeState = vi.fn();
let submitPending = false;

vi.mock("../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({
    mutateAsync: mockMutateAsync,
    stop: vi.fn(),
  }),
  // The composer reads the SESSION-FILTERED answer, never the hook-wide
  // `isPending` (a resident composer would otherwise inherit another
  // session's turn). The fixture answers for the session under test only.
  useIsChatSubmitting: (sessionId: string | null) =>
    submitPending && sessionId === SESSION,
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
  useRequestStop: () => ({ mutateAsync: vi.fn() }),
}));

const { useComposerSubmit } = await import("../composer-submit.js");

const SESSION = "00000000-0000-4000-8000-000000000001";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function submitEvent(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

async function typeAndSubmit(
  result: { current: { setDraft: (d: string) => void; onSubmit: (e: FormEvent<HTMLFormElement>) => Promise<void> } },
  text: string,
): Promise<void> {
  act(() => result.current.setDraft(text));
  await act(async () => result.current.onSubmit(submitEvent()));
}

beforeEach(() => {
  vi.clearAllMocks();
  submitPending = true; // a turn is in flight unless a test says otherwise
  resetComposerQueueForTest();
  resetDraftsForTest();
  mockUseRuntimeState.mockReturnValue({
    data: {
      ok: true,
      data: { sessionId: SESSION, status: null, leaseActive: true, stoppable: true },
    },
  });
  mockSteer.mockResolvedValue({ ok: true, data: { outcome: "queued_live" } });
  (window as unknown as { vex: unknown }).vex = {
    chat: { steer: mockSteer },
  };
});
afterEach(cleanup);

describe("mid-turn submit steers the live turn", () => {
  it("queued_live: the text is on the tape, so it never ALSO queues, and the toast says when it lands", async () => {
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );
    await typeAndSubmit(result, "check the fees first");
    expect(mockSteer).toHaveBeenCalledWith({
      sessionId: SESSION,
      message: "check the fees first",
    });
    expect(readQueue(SESSION)).toHaveLength(0);
    await waitFor(() =>
      expect(getToastSnapshot()?.text).toBe(
        "Steering queued - the agent reads it at its next step.",
      ),
    );
    // The draft cleared: the message left the composer.
    expect(result.current.draft).toBe("");
  });

  it("no_active_turn: the turn ended under the race - the text falls back to the A27 queue, never dropped", async () => {
    mockSteer.mockResolvedValue({ ok: true, data: { outcome: "no_active_turn" } });
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );
    await typeAndSubmit(result, "check the fees first");
    expect(readQueue(SESSION).map((r) => r.text)).toEqual(["check the fees first"]);
  });

  it("a steer refusal (handler error = nothing persisted) also falls back to the queue", async () => {
    mockSteer.mockResolvedValue({
      ok: false,
      error: { code: "internal.unexpected", domain: "chat", message: "x" },
    });
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );
    await typeAndSubmit(result, "still here?");
    expect(readQueue(SESSION).map((r) => r.text)).toEqual(["still here?"]);
  });

  it("an idle-session submit never touches the steer channel - steering exists only while a turn is live", async () => {
    submitPending = false;
    mockMutateAsync.mockResolvedValue({ ok: true, data: { text: "hi" } });
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );
    await typeAndSubmit(result, "normal message");
    expect(mockSteer).not.toHaveBeenCalled();
  });
});

describe("the steered row in the transcript", () => {
  it("wears its delivery words - the user reads WHEN the agent sees it", () => {
    const { container, getByText } = render(
      <TranscriptMessage
        row={{
          id: 42,
          variant: "user",
          label: null,
          content: "check the fees first",
          createdAt: "2026-08-20T10:00:00.000Z",
          reasoning: null,
          steering: true,
        }}
      />,
    );
    expect(container.querySelector("[data-vex-steering-mark]")).not.toBeNull();
    expect(getByText("Steered · read at the agent's next step")).toBeTruthy();
  });

  it("an ordinary user row wears no steering mark", () => {
    const { container } = render(
      <TranscriptMessage
        row={{
          id: 43,
          variant: "user",
          label: null,
          content: "plain ask",
          createdAt: "2026-08-20T10:00:00.000Z",
          reasoning: null,
        }}
      />,
    );
    expect(container.querySelector("[data-vex-steering-mark]")).toBeNull();
  });
});
