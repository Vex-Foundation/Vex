/**
 * Tests for the compaction status hooks (stage 7-1).
 *
 *  - `isCompactionActive` drives the dynamic poll cadence (fast while a job
 *    is in flight, slow otherwise);
 *  - `useCompactionLiveSync` subscribes/unsubscribes, ignores foreign-session
 *    transcript events, and invalidates only the session's compaction key.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";
import type { TranscriptAppendEvent } from "@shared/schemas/messages.js";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import {
  COMPACTION_ACTIVE_POLL_MS,
  COMPACTION_IDLE_POLL_MS,
  isCompactionActive,
  useCompactionLiveSync,
} from "../compaction.js";
import { compactionKeys } from "../queryKeys.js";

type TranscriptListener = (event: TranscriptAppendEvent) => void;

/** Minimal valid append event — the hook only reads `sessionId`. */
function transcriptAppend(sessionId: string): TranscriptAppendEvent {
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

let lastListener: TranscriptListener | null = null;
const unsubscribeMock = vi.fn();

beforeEach(() => {
  lastListener = null;
  unsubscribeMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onTranscriptAppend: (cb) => {
          lastListener = cb;
          return unsubscribeMock;
        },
      }),
    },
  });
});

afterEach(() => {
  // @ts-expect-error — test cleanup
  delete window.vex;
});

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

describe("isCompactionActive", () => {
  it("is true only for an ok, non-null result with activeCount > 0", () => {
    expect(isCompactionActive(undefined)).toBe(false);
    expect(isCompactionActive({ ok: true, data: null })).toBe(false);
    expect(
      isCompactionActive({
        ok: true,
        data: { sessionId: A, latest: null, activeCount: 0 },
      }),
    ).toBe(false);
    expect(
      isCompactionActive({
        ok: true,
        data: { sessionId: A, latest: null, activeCount: 2 },
      }),
    ).toBe(true);
    expect(
      isCompactionActive({
        ok: false,
        error: {
          code: "internal.unexpected",
          domain: "compaction",
          message: "x",
          retryable: true,
          userActionable: false,
          redacted: true,
          correlationId: "c",
        },
      }),
    ).toBe(false);
  });

  it("polls faster while active than when idle, both bounded", () => {
    expect(COMPACTION_ACTIVE_POLL_MS).toBeGreaterThan(0);
    expect(COMPACTION_ACTIVE_POLL_MS).toBeLessThan(COMPACTION_IDLE_POLL_MS);
  });
});

describe("useCompactionLiveSync", () => {
  it("subscribes on mount and unsubscribes on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useCompactionLiveSync(A), {
      wrapper: makeWrapper(client),
    });
    expect(lastListener).not.toBeNull();
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops on a null sessionId (no subscribe)", () => {
    const client = new QueryClient();
    renderHook(() => useCompactionLiveSync(null), {
      wrapper: makeWrapper(client),
    });
    expect(lastListener).toBeNull();
  });

  it("invalidates only the session's compaction key on a matching event", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useCompactionLiveSync(A), { wrapper: makeWrapper(client) });

    lastListener!(transcriptAppend(B));
    expect(spy).not.toHaveBeenCalled();

    lastListener!(transcriptAppend(A));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toEqual({
      queryKey: compactionKeys.status(A),
    });
  });
});
