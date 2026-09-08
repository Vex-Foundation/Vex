/**
 * THE RESIDENT COMPOSER MUST NOT LEAK ONE SESSION'S TURN INTO ANOTHER.
 *
 * Residency (round 2) stopped the composer remounting per session, which made
 * every hook-wide value in `composer-submit.ts` a cross-session channel. The
 * hook read the UNSCOPED `useSubmitChat().isPending`, held a single boolean
 * in-flight mutex, and published Stop outcomes with no generation fence. The
 * consequences, all reproduced below, were:
 *
 *  - session B looked busy because session A's turn was still running;
 *  - B's first send took the STEER/QUEUE branch instead of being a fresh send,
 *    so the message was delivered as an interrupt to A's loop or parked in B's
 *    queue behind a turn that was never B's;
 *  - B's Stop key fired the cancellation handle A's request had installed -
 *    a cancellation aimed at a conversation the user was not looking at;
 *  - a Stop failure from A painted "Stop failed" (and a "Stopping…" badge) on
 *    B after the switch.
 *
 * Cancelling the wrong session's turn is a real-consequence action in an agent
 * that spends funds, so these are contract tests, not cosmetics. Each one is
 * red if the corresponding scoping is reverted.
 *
 * The chat API is REAL here (the session filter and the session-keyed cancel
 * handle are exactly what is under test); only the IPC surface, the runtime
 * read and the steering attempt are stubbed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type FormEvent, type ReactNode } from "react";

const mockTrySteerLiveTurn = vi.fn();
const mockRequestStopMutate = vi.fn();
const mockUseRuntimeState = vi.fn();

vi.mock("../composer-submit/steering.js", () => ({
  trySteerLiveTurn: (...a: unknown[]) => mockTrySteerLiveTurn(...a),
  STEERED_TOAST_TEXT: "steered",
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
  useRequestStop: () => ({ mutateAsync: mockRequestStopMutate }),
}));

const { useComposerSubmit } = await import("../composer-submit.js");
const { resetDraftsForTest } = await import("../../../lib/composer-drafts.js");
const { resetComposerQueueForTest, readQueue } = await import(
  "../../../lib/composer-queue.js"
);
const { subscribeLighterWorkspaceOpen } = await import(
  "../lighterTrading/workspace-command.js"
);

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";

const submitMock = vi.fn();
const cancelA = vi.fn();
const cancelB = vi.fn();

/** A turn that never settles, so "A is still running" is a stable state. */
function pendingInvocation(cancel: () => void) {
  return { promise: new Promise<never>(() => undefined), cancel };
}

/**
 * ONE client per test, created in `beforeEach`. It must NOT be built inside the
 * wrapper component: that runs on every render, and a fresh client each render
 * would throw away the very mutation cache `useIsChatSubmitting` reads.
 */
let client: QueryClient;

function wrapper({ children }: { readonly children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

function submitEvent(): FormEvent<HTMLFormElement> {
  return { preventDefault: vi.fn() } as unknown as FormEvent<HTMLFormElement>;
}

/** `stoppable` is the composer's Stop-availability signal. */
function runtimeState(stoppable: boolean) {
  return {
    data: { ok: true, data: { sessionId: null, status: null, stoppable } },
    isError: false,
  };
}

function renderComposer(sessionId: string) {
  return renderHook(
    ({ id }: { id: string }) => useComposerSubmit(id, null, false, null),
    { wrapper, initialProps: { id: sessionId } },
  );
}

async function typeAndSubmit(
  result: { current: ReturnType<typeof useComposerSubmit> },
  text: string,
): Promise<void> {
  act(() => {
    result.current.setDraft(text);
  });
  // NOT awaited: the stubbed invocation never settles (that is what keeps "A
  // is still running" a stable state), so `onSubmit`'s promise never resolves.
  // One microtask flush is enough for the mutation to reach `pending`.
  await act(async () => {
    void result.current.onSubmit(submitEvent());
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  resetDraftsForTest();
  resetComposerQueueForTest();
  mockTrySteerLiveTurn.mockResolvedValue("steered");
  mockRequestStopMutate.mockResolvedValue({ ok: true, data: {} });
  mockUseRuntimeState.mockReturnValue(runtimeState(true));
  submitMock.mockImplementation((input: { sessionId: string }) =>
    pendingInvocation(input.sessionId === SESSION_A ? cancelA : cancelB),
  );
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: { chat: { submit: submitMock } },
  });
});

afterEach(() => {
  // @ts-expect-error — test cleanup
  delete window.vex;
});

describe("resident composer - a turn belongs to ONE session", () => {
  it("consumes Light it up as UI-only and never submits it as a user turn", async () => {
    const openListener = vi.fn();
    const unsubscribe = subscribeLighterWorkspaceOpen(openListener);
    const view = renderComposer(SESSION_A);

    await typeAndSubmit(view.result, "Light it up");

    expect(openListener).toHaveBeenCalledTimes(1);
    expect(submitMock).not.toHaveBeenCalled();
    expect(mockTrySteerLiveTurn).not.toHaveBeenCalled();
    expect(readQueue(SESSION_A)).toHaveLength(0);
    expect(view.result.current.draft).toBe("");
    unsubscribe();
  });

  it("does not report session B pending while session A's turn runs", async () => {
    const view = renderComposer(SESSION_A);
    await typeAndSubmit(view.result, "run for A");
    await waitFor(() => expect(view.result.current.submitPending).toBe(true));

    view.rerender({ id: SESSION_B });
    expect(view.result.current.submitPending).toBe(false);
  });

  it("sends B's message as a FRESH send, never as a steer or a queued row", async () => {
    const view = renderComposer(SESSION_A);
    await typeAndSubmit(view.result, "run for A");
    await waitFor(() => expect(view.result.current.submitPending).toBe(true));

    view.rerender({ id: SESSION_B });
    await typeAndSubmit(view.result, "hello B");

    // The steer branch belongs to a turn running in THIS session. B has none.
    expect(mockTrySteerLiveTurn).not.toHaveBeenCalled();
    expect(readQueue(SESSION_B)).toHaveLength(0);
    expect(submitMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: SESSION_B, message: "hello B" }),
    );
  });

  it("B's Stop never fires the cancellation handle A's request installed", async () => {
    const view = renderComposer(SESSION_A);
    await typeAndSubmit(view.result, "run for A");
    await waitFor(() => expect(view.result.current.submitPending).toBe(true));

    view.rerender({ id: SESSION_B });
    act(() => {
      view.result.current.onStop();
    });

    expect(cancelA).not.toHaveBeenCalled();
    // B has no foreground request, so its Stop takes the durable route - and
    // that route names B, not the session that happens to be running.
    await waitFor(() =>
      expect(mockRequestStopMutate).toHaveBeenCalledWith({
        sessionId: SESSION_B,
      }),
    );
  });

  it("A's own Stop still cancels A's in-flight request", async () => {
    // The fence must not be so tight that the real case stops working.
    const view = renderComposer(SESSION_A);
    await typeAndSubmit(view.result, "run for A");
    await waitFor(() => expect(view.result.current.submitPending).toBe(true));

    act(() => {
      view.result.current.onStop();
    });
    expect(cancelA).toHaveBeenCalledTimes(1);
    expect(mockRequestStopMutate).not.toHaveBeenCalled();
  });

  it("a late Stop FAILURE from A publishes nothing into B", async () => {
    let failStop!: () => void;
    mockRequestStopMutate.mockImplementation(
      async () =>
        new Promise((resolve) => {
          failStop = () => resolve({ ok: false, error: { message: "nope" } });
        }),
    );
    // A background slice in A: stoppable, nothing pending in this window, so
    // Stop takes the durable route and its outcome arrives asynchronously.
    const view = renderComposer(SESSION_A);
    act(() => {
      view.result.current.onStop();
    });
    expect(view.result.current.stopRequested).toBe(true);

    view.rerender({ id: SESSION_B });
    expect(view.result.current.stopRequested).toBe(false);

    await act(async () => {
      failStop();
      await Promise.resolve();
    });

    // B never asked for a stop, so it must show neither the failure notice nor
    // the "Stopping…" acknowledgment.
    expect(view.result.current.notice).toBeNull();
    expect(view.result.current.stopRequested).toBe(false);
  });
});
