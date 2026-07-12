/**
 * Tests for `useSubmitChat` (puzzle 06 + stage 9-5b).
 *
 * A completed turn advances usage rows + the session token_count, so the
 * mutation must invalidate the session list/detail AND every usage query
 * for the session (totals, last-turn, context-window). A failed result
 * must NOT invalidate anything.
 *
 * 9-5b: `window.vex.chat.submit` now returns an abortable invocation; the
 * hook exposes a stable `stop()` that fires the captured `cancel`, and the
 * cancel handle is cleared only by the invocation that installed it (a
 * settling older turn must not null a newer turn's handle).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import { useSubmitChat } from "../chat.js";
import { sessionKeys } from "../sessions.js";
import { approvalsKeys, usageKeys } from "../queryKeys.js";

const SESSION = "00000000-0000-4000-8000-0000000000c2";
const submitMock = vi.fn();

beforeEach(() => {
  submitMock.mockReset();
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

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("useSubmitChat onSuccess invalidation", () => {
  it("invalidates session list/detail + usage queries for the session", async () => {
    submitMock.mockReturnValue({
      promise: Promise.resolve({ ok: true, data: { text: null } }),
      cancel: vi.fn(),
    });
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useSubmitChat(), {
      wrapper: makeWrapper(client),
    });

    await result.current.mutateAsync({ sessionId: SESSION, message: "hello" });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: sessionKeys.list() });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.detail(SESSION),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: sessionKeys.plan(SESSION),
    });

    const predicateCall = invalidateSpy.mock.calls.find(
      (c) => typeof (c[0] as { predicate?: unknown }).predicate === "function",
    );
    expect(predicateCall).toBeDefined();
    const predicate = (
      predicateCall![0] as {
        predicate: (q: { queryKey: readonly unknown[] }) => boolean;
      }
    ).predicate;
    expect(predicate({ queryKey: usageKeys.contextWindow(SESSION) })).toBe(true);
    expect(predicate({ queryKey: usageKeys.lastTurn(SESSION, "USD") })).toBe(true);
  });

  it("does not invalidate on a failed result", async () => {
    submitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "chat",
          message: "x",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "c",
        },
      }),
      cancel: vi.fn(),
    });
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useSubmitChat(), {
      wrapper: makeWrapper(client),
    });

    await result.current.mutateAsync({ sessionId: SESSION, message: "hello" });

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("immediately refreshes inline and global approvals when the turn enqueues one", async () => {
    submitMock.mockReturnValue({
      promise: Promise.resolve({
        ok: true,
        data: { text: null, pendingApprovals: ["approval-1"] },
      }),
      cancel: vi.fn(),
    });
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useSubmitChat(), {
      wrapper: makeWrapper(client),
    });

    await result.current.mutateAsync({ sessionId: SESSION, message: "send it" });

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: approvalsKeys.pending(SESSION),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: approvalsKeys.pendingAll(),
    });
  });
});

describe("useSubmitChat stop / cancel ownership (9-5b)", () => {
  it("stop() fires the captured in-flight invocation's cancel", async () => {
    const cancel = vi.fn();
    let settle!: (r: { ok: true; data: { text: null } }) => void;
    submitMock.mockReturnValue({
      promise: new Promise<{ ok: true; data: { text: null } }>((res) => {
        settle = res;
      }),
      cancel,
    });
    const client = new QueryClient();
    const { result } = renderHook(() => useSubmitChat(), {
      wrapper: makeWrapper(client),
    });

    void result.current.mutate({ sessionId: SESSION, message: "hi" });
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));

    result.current.stop();
    expect(cancel).toHaveBeenCalledTimes(1);

    await act(async () => {
      settle({ ok: true, data: { text: null } });
      await Promise.resolve();
    });
  });

  it("a settling older invocation does not clear a newer invocation's cancel", async () => {
    const cancel1 = vi.fn();
    const cancel2 = vi.fn();
    let settle1!: (r: { ok: true; data: { text: null } }) => void;
    let settle2!: (r: { ok: true; data: { text: null } }) => void;
    submitMock
      .mockReturnValueOnce({
        promise: new Promise<{ ok: true; data: { text: null } }>((res) => {
          settle1 = res;
        }),
        cancel: cancel1,
      })
      .mockReturnValueOnce({
        promise: new Promise<{ ok: true; data: { text: null } }>((res) => {
          settle2 = res;
        }),
        cancel: cancel2,
      });
    const client = new QueryClient();
    const { result } = renderHook(() => useSubmitChat(), {
      wrapper: makeWrapper(client),
    });

    // Two overlapping submits: the second captures the live cancel handle.
    void result.current.mutate({ sessionId: SESSION, message: "a" });
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(1));
    void result.current.mutate({ sessionId: SESSION, message: "b" });
    await waitFor(() => expect(submitMock).toHaveBeenCalledTimes(2));

    // The OLDER turn settles first — its finally must NOT null the handle.
    await act(async () => {
      settle1({ ok: true, data: { text: null } });
      await Promise.resolve();
    });

    result.current.stop();
    expect(cancel2).toHaveBeenCalledTimes(1);
    expect(cancel1).not.toHaveBeenCalled();

    await act(async () => {
      settle2({ ok: true, data: { text: null } });
      await Promise.resolve();
    });
  });
});
