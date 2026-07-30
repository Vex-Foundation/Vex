/**
 * Tests for the usage query-key predicate + live-sync hook (puzzle 06).
 *
 * Verifies:
 *  - `isUsageQueryForSession` matches every usage key kind for a session
 *    (sessionTotals / lastTurn / contextWindow at index 2) and rejects
 *    other sessions + non-usage keys;
 *  - `useUsageLiveSync` subscribes/unsubscribes, ignores foreign-session
 *    events, invalidates via the predicate, and runs the 30s fallback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";
import type { TranscriptAppendEvent } from "@shared/schemas/messages.js";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import { useUsageLiveSync, USAGE_LIVE_FALLBACK_POLL_MS } from "../usage.js";
import { isUsageQueryForSession, usageKeys } from "../queryKeys.js";

type TranscriptListener = (event: TranscriptAppendEvent) => void;

let lastSubscribedListener: TranscriptListener | null = null;
const unsubscribeMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  lastSubscribedListener = null;
  unsubscribeMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onTranscriptAppend: (cb) => {
          lastSubscribedListener = cb;
          return unsubscribeMock;
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

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";
const CURRENCY = "USD";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function sampleEvent(sessionId: string): TranscriptAppendEvent {
  return {
    type: "engine.transcript.append",
    sessionId,
    messageId: 1,
    role: "assistant",
    createdAt: "2026-05-21T10:00:00.000Z",
    messageType: null,
    correlationId: null,
  };
}

describe("isUsageQueryForSession", () => {
  it("matches every usage key kind for the session at index 2", () => {
    expect(
      isUsageQueryForSession(usageKeys.sessionTotals(SESSION_A, CURRENCY), SESSION_A),
    ).toBe(true);
    expect(
      isUsageQueryForSession(usageKeys.lastTurn(SESSION_A, CURRENCY), SESSION_A),
    ).toBe(true);
    expect(
      isUsageQueryForSession(usageKeys.contextWindow(SESSION_A), SESSION_A),
    ).toBe(true);
  });

  it("rejects a different session and non-usage keys", () => {
    expect(
      isUsageQueryForSession(usageKeys.contextWindow(SESSION_B), SESSION_A),
    ).toBe(false);
    expect(isUsageQueryForSession(["messages", SESSION_A], SESSION_A)).toBe(false);
  });
});

describe("useUsageLiveSync", () => {
  it("subscribes on mount and unsubscribes on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useUsageLiveSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });
    expect(lastSubscribedListener).not.toBeNull();
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops on null sessionId (no subscribe)", () => {
    const client = new QueryClient();
    renderHook(() => useUsageLiveSync(null), { wrapper: makeWrapper(client) });
    expect(lastSubscribedListener).toBeNull();
  });

  it("invalidates usage queries for the session on a matching event", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useUsageLiveSync(SESSION_A), { wrapper: makeWrapper(client) });

    lastSubscribedListener!(sampleEvent(SESSION_A));

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    const arg = invalidateSpy.mock.calls[0]![0] as {
      predicate: (q: { queryKey: readonly unknown[] }) => boolean;
    };
    expect(typeof arg.predicate).toBe("function");
    expect(arg.predicate({ queryKey: usageKeys.contextWindow(SESSION_A) })).toBe(true);
    expect(
      arg.predicate({ queryKey: usageKeys.sessionTotals(SESSION_A, CURRENCY) }),
    ).toBe(true);
    expect(arg.predicate({ queryKey: usageKeys.contextWindow(SESSION_B) })).toBe(false);
  });

  it("ignores events for a different session", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useUsageLiveSync(SESSION_A), { wrapper: makeWrapper(client) });

    lastSubscribedListener!(sampleEvent(SESSION_B));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("runs the 30s fallback poll while mounted, stops after unmount", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");
    const { unmount } = renderHook(() => useUsageLiveSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(USAGE_LIVE_FALLBACK_POLL_MS);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(USAGE_LIVE_FALLBACK_POLL_MS);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);

    unmount();
    vi.advanceTimersByTime(USAGE_LIVE_FALLBACK_POLL_MS);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });
});
