/**
 * A4 - ASK VEX REACHES THE AGENT THROUGH THE COMPOSER, or not at all.
 *
 * The board modal parks an intent; the RESIDENT composer dispatches it through
 * the same high-level path a typed message takes. What that buys, and what
 * this file pins, is that a board question obeys every rule a typed one does:
 * the in-flight mutex, steering with the queue as its fallback, the mission
 * free-text gate, the retry contract. A second submit path in the modal would
 * have had to reimplement all four, and would have got at least one wrong.
 *
 * The seven scenarios are the ones A4 named:
 *   1. idle submit,
 *   2. a turn in flight steers,
 *   3. steering refused queues,
 *   4. a mission run refuses free text,
 *   5. a retryable failure arms Retry with the SAME envelope,
 *   6. an intent for another session is DROPPED, never sent,
 *   7. StrictMode's double effect sends once.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, StrictMode, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { readQueue, resetComposerQueueForTest } from "../../../lib/composer-queue.js";
import { resetDraftsForTest } from "../../../lib/composer-drafts.js";
import { getToastSnapshot } from "../../../lib/toast.js";
import { useBoardAskIntentStore } from "../Board/board-ask-intent.js";

const mockSteer = vi.fn();
const mockMutateAsync = vi.fn();
const mockUseRuntimeState = vi.fn();
let submitPending = false;

vi.mock("../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({ mutateAsync: mockMutateAsync, stop: vi.fn() }),
  useIsChatSubmitting: (sessionId: string | null) =>
    submitPending && sessionId === SESSION,
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
  useRequestStop: () => ({ mutateAsync: vi.fn() }),
}));

const { useComposerSubmit } = await import("../composer-submit.js");

const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-000000000002";

const AGENT_SESSION = {
  id: SESSION,
  mode: "agent",
} as unknown as Parameters<typeof useComposerSubmit>[1];

/** A finished Ask VEX envelope, as `AskVexPanel` would have built it. */
const ENVELOPE = [
  "[Board context]",
  "Board: Token Radar",
  "Token: UBERCAT on base",
  "Pair: 0xaaa111 on uniswap",
  "Price: 0.0001324 USD",
  "Figures: snapshot, read at 2026-07-04 13:45 UTC",
  "",
  "Why is it moving?",
].join("\n");

function askIntent(overrides: { readonly sessionId?: string; readonly intentId?: string } = {}) {
  return {
    sessionId: overrides.sessionId ?? SESSION,
    boardKey: `${overrides.sessionId ?? SESSION}:12`,
    intentId: overrides.intentId ?? "intent-1",
    context: {
      boardTitle: "Token Radar",
      tokenSymbol: "UBERCAT",
      tokenName: "UBERCAT",
      chain: "base",
      pairAddress: "0xaaa111",
      ammId: "uniswap",
      priceUsd: "0.0001324",
      dataMode: "snapshot" as const,
      observedAtMs: 1_783_172_700_000,
    },
    message: ENVELOPE,
  };
}

function wrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function strictWrapper({ children }: { readonly children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(
    StrictMode,
    null,
    createElement(QueryClientProvider, { client }, children),
  );
}

function runtimeState(status: string | null): void {
  mockUseRuntimeState.mockReturnValue({
    data: {
      ok: true,
      data: { sessionId: SESSION, status, leaseActive: false, stoppable: false },
    },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  submitPending = false;
  resetComposerQueueForTest();
  resetDraftsForTest();
  runtimeState(null);
  mockMutateAsync.mockResolvedValue({
    ok: true,
    data: { stopReason: "end_turn", toolCallsMade: 0 },
  });
  mockSteer.mockResolvedValue({ ok: true, data: { outcome: "queued_live" } });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { chat: { steer: mockSteer } },
  });
  useBoardAskIntentStore.setState({ intent: null });
});

afterEach(() => {
  cleanup();
  useBoardAskIntentStore.setState({ intent: null });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: undefined,
  });
});

function mountComposer(session = AGENT_SESSION, sessionId: string | null = SESSION) {
  return renderHook(() => useComposerSubmit(sessionId, session, false, null), {
    wrapper,
  });
}

describe("board Ask VEX through the resident composer", () => {
  it("1. idle session: the envelope is submitted verbatim", async () => {
    mountComposer();
    await act(async () => {
      useBoardAskIntentStore.getState().publishBoardAskIntent(askIntent());
    });
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(mockMutateAsync.mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION,
      message: ENVELOPE,
    });
    // Consumed: the slot is empty, so a re-render cannot resend it.
    expect(useBoardAskIntentStore.getState().intent).toBeNull();
  });

  it("2. a turn in flight: the question STEERS the live turn instead of racing it", async () => {
    submitPending = true;
    mountComposer();
    await act(async () => {
      useBoardAskIntentStore.getState().publishBoardAskIntent(askIntent());
    });
    await waitFor(() => {
      expect(mockSteer).toHaveBeenCalledTimes(1);
    });
    expect(mockSteer.mock.calls[0]?.[0]).toEqual({
      sessionId: SESSION,
      message: ENVELOPE,
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(readQueue(SESSION)).toHaveLength(0);
    expect(getToastSnapshot()).not.toBeNull();
  });

  it("3. steering refused: the question QUEUES rather than being dropped", async () => {
    submitPending = true;
    mockSteer.mockResolvedValue({ ok: true, data: { outcome: "no_active_turn" } });
    mountComposer();
    await act(async () => {
      useBoardAskIntentStore.getState().publishBoardAskIntent(askIntent());
    });
    await waitFor(() => {
      expect(readQueue(SESSION)).toHaveLength(1);
    });
    expect(readQueue(SESSION)[0]?.text).toBe(ENVELOPE);
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("4. a mission run refuses free text, and says so instead of sending", async () => {
    runtimeState("running");
    const { result } = mountComposer();
    await act(async () => {
      useBoardAskIntentStore.getState().publishBoardAskIntent(askIntent());
    });
    await waitFor(() => {
      expect(result.current.notice?.tone).toBe("error");
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(readQueue(SESSION)).toHaveLength(0);
  });

  it("5. a retryable failure arms Retry with the SAME envelope", async () => {
    mockMutateAsync.mockResolvedValue({
      ok: false,
      error: { message: "Provider is busy", retryable: true },
    });
    const { result } = mountComposer();
    await act(async () => {
      useBoardAskIntentStore.getState().publishBoardAskIntent(askIntent());
    });
    await waitFor(() => {
      expect(result.current.notice?.retry?.message).toBe(ENVELOPE);
    });
    expect(result.current.notice?.retry?.sessionId).toBe(SESSION);

    mockMutateAsync.mockResolvedValue({
      ok: true,
      data: { stopReason: "end_turn", toolCallsMade: 0 },
    });
    await act(async () => {
      result.current.onRetry();
    });
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(2);
    });
    expect(mockMutateAsync.mock.calls[1]?.[0]).toEqual({
      sessionId: SESSION,
      message: ENVELOPE,
    });
  });

  it("6. an intent for ANOTHER session is dropped, never sent into this one", async () => {
    mountComposer();
    await act(async () => {
      useBoardAskIntentStore
        .getState()
        .publishBoardAskIntent(askIntent({ sessionId: OTHER_SESSION }));
    });
    await waitFor(() => {
      expect(useBoardAskIntentStore.getState().intent).toBeNull();
    });
    expect(mockMutateAsync).not.toHaveBeenCalled();
    expect(mockSteer).not.toHaveBeenCalled();
    expect(readQueue(SESSION)).toHaveLength(0);
    expect(readQueue(OTHER_SESSION)).toHaveLength(0);
  });

  it("7. StrictMode's double effect sends the question exactly once", async () => {
    renderHook(() => useComposerSubmit(SESSION, AGENT_SESSION, false, null), {
      wrapper: strictWrapper,
    });
    await act(async () => {
      useBoardAskIntentStore.getState().publishBoardAskIntent(askIntent());
    });
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    // Settle any second pass before asserting the count is still one.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockMutateAsync).toHaveBeenCalledTimes(1);
  });
});

describe("the typed-message path is unchanged by the hand-off", () => {
  it("still keeps the draft when a mission run gates the send", async () => {
    runtimeState("running");
    const { result } = mountComposer();
    act(() => {
      result.current.setDraft("hello");
    });
    await act(async () =>
      result.current.onSubmit({
        preventDefault: vi.fn(),
      } as unknown as Parameters<typeof result.current.onSubmit>[0]),
    );
    expect(result.current.notice?.tone).toBe("error");
    expect(result.current.draft).toBe("hello");
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("still clears the draft and submits when the session is idle", async () => {
    const { result } = mountComposer();
    act(() => {
      result.current.setDraft("hello");
    });
    await act(async () =>
      result.current.onSubmit({
        preventDefault: vi.fn(),
      } as unknown as Parameters<typeof result.current.onSubmit>[0]),
    );
    await waitFor(() => {
      expect(mockMutateAsync).toHaveBeenCalledTimes(1);
    });
    expect(result.current.draft).toBe("");
  });
});

