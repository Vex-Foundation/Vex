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
import { notifications } from "../../../lib/notifications/index.js";

/**
 * The transient toast is a notification-model entry since B2.2: the store that
 * held one message and forgot it is gone, so the assertions read the model's
 * newest retained item instead of a slot.
 */
function latestToastText(): string | null {
  return notifications.getSnapshot().items[0]?.message ?? null;
}

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
afterEach(() => {
  cleanup();
  notifications.reset();
});

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
      expect(latestToastText()).toBe(
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
  /**
   * M6. The mark's WORDS come from the engine's typed disposition, never from
   * the row kind. Every operator-interrupt row used to render the steered
   * sentence, so a message queued against a parked run claimed it would be
   * read at the agent's next step - directly beside the acknowledgement row,
   * written in the SAME transaction from the SAME value, saying the agent was
   * not running. These are the four states the transcript can show.
   */
  it.each([
    [
      "steered" as const,
      "Steered \u00b7 read at the agent's next step",
    ],
    [
      "queued_interrupt" as const,
      "Queued \u00b7 read the next time the agent runs",
    ],
    [
      "preempted_wake" as const,
      "Sent \u00b7 the agent is resuming now to read it",
    ],
  ])("a %s row wears that disposition's delivery words", (disposition, words) => {
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
          interruptDisposition: disposition,
        }}
      />,
    );
    const mark = container.querySelector("[data-vex-steering-mark]");
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("data-vex-disposition")).toBe(disposition);
    expect(getByText(words)).toBeTruthy();
  });

  /**
   * A legacy interrupt row, written before the disposition existed. It makes
   * the neutral claim - the one thing that is true whatever happened - rather
   * than guessing the optimistic one.
   */
  it("a row with no recorded disposition makes no timing claim", () => {
    const { container, getByText } = render(
      <TranscriptMessage
        row={{
          id: 44,
          variant: "user",
          label: null,
          content: "legacy interrupt",
          createdAt: "2026-08-20T10:00:00.000Z",
          reasoning: null,
          steering: true,
        }}
      />,
    );
    expect(container.querySelector("[data-vex-steering-mark]")).not.toBeNull();
    expect(getByText("Sent to the agent")).toBeTruthy();
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
