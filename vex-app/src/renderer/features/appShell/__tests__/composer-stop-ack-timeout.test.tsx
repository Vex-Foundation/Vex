/**
 * T6 — the Stop acknowledgment must never outlive its usefulness.
 *
 * The "Stopping…" state was cleared by exactly one path: the settle effect that
 * waits for `submitPending` to drop AND the lease to go inactive. But a slice
 * stuck in an uninterruptible leg keeps heart-beating its lease, so `sliceLive`
 * stays true for as long as the work blocks — and if the terminal `controlState`
 * event is dropped too, the runtime-state fallback poll is 60 s behind it.
 *
 * The result was a disabled control reading "Stopping…" indefinitely while the
 * agent visibly kept working: no timer, no escape, no second-press semantics.
 * A badge that says stopped while work continues is the worst possible lie on
 * this control — the same principle the `ok:false` recovery already encodes.
 *
 * Pinned here: the acknowledgment is time-boxed, the notice tells the truth
 * (still finishing, not failed), and the re-armed control fires a real second
 * request.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const mockStopTurn = vi.fn();
const mockRequestStopMutate = vi.fn();
const mockUseRuntimeState = vi.fn();

vi.mock("../../../lib/api/chat.js", () => ({
  useSubmitChat: () => ({
    // Background slice: nothing pending in THIS window, so the settle effect
    // depends entirely on the lease — which never drops here, by design.
    isPending: false,
    mutateAsync: vi.fn(),
    stop: mockStopTurn,
  }),
}));

vi.mock("../../../lib/api/runtime.js", () => ({
  useRuntimeState: (...a: unknown[]) => mockUseRuntimeState(...a),
  useRequestStop: () => ({ mutateAsync: mockRequestStopMutate }),
}));

const { useComposerSubmit } = await import("../composer-submit.js");

const SESSION = "00000000-0000-4000-8000-000000000001";

/** A lease that stays active forever — the stuck-slice case. */
function liveRuntimeState() {
  return {
    data: {
      ok: true,
      data: { sessionId: SESSION, status: null, leaseActive: true, stoppable: true },
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mockUseRuntimeState.mockReturnValue(liveRuntimeState());
  mockRequestStopMutate.mockResolvedValue({ ok: true, data: { outcome: "queued" } });
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("stop acknowledgment time-box", () => {
  it("holds the acknowledgment while the stop could still be landing", async () => {
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );

    await act(async () => { result.current.onStop(); });
    expect(result.current.stopRequested).toBe(true);

    // Just short of the box: still acknowledging, still silent.
    await act(async () => { await vi.advanceTimersByTimeAsync(7_999); });
    expect(result.current.stopRequested).toBe(true);
    expect(result.current.notice).toBeNull();
  });

  it("re-arms the control and says what is actually happening once the box expires", async () => {
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );

    await act(async () => { result.current.onStop(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });

    expect(result.current.stopRequested).toBe(false);
    expect(result.current.notice).toEqual({
      tone: "info",
      text: "Stop was requested but the agent is still finishing a step it cannot safely interrupt.",
    });
    // Not an error: the request DID land, and the run may yet stop.
    expect(result.current.notice?.tone).not.toBe("error");
  });

  it("makes the second press real — the durable request fires again", async () => {
    const { result } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );

    await act(async () => { result.current.onStop(); });
    expect(mockRequestStopMutate).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(8_000); });
    await act(async () => { result.current.onStop(); });

    // The enqueue is idempotent, so re-firing costs nothing and is the only
    // thing that gives the user a control that still does something.
    expect(mockRequestStopMutate).toHaveBeenCalledTimes(2);
    expect(result.current.stopRequested).toBe(true);
  });

  it("cancels the box when the work actually settles, leaving no late notice", async () => {
    const { result, rerender } = renderHook(
      () => useComposerSubmit(SESSION, null, false, null),
      { wrapper },
    );

    await act(async () => { result.current.onStop(); });

    // The lease drops — the stop landed — before the box expires.
    mockUseRuntimeState.mockReturnValue({
      data: {
        ok: true,
        data: { sessionId: SESSION, status: null, leaseActive: false, stoppable: false },
      },
    });
    await act(async () => { rerender(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });

    expect(result.current.stopRequested).toBe(false);
    expect(result.current.notice).toBeNull();
  });
});
