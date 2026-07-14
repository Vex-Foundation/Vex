/**
 * Tests for the transcript query layer (agent integration puzzle 02 + stage
 * 8-2b):
 *  - `useTranscriptLiveSync`: subscribe + setInterval wiring on mount; the
 *    invalidation prefix `messagesKeys.forSession(s)` reaches the infinite
 *    transcript key (any limit); mismatched sessionId payloads are ignored;
 *    unmount unsubscribes + clears the interval;
 *  - `flattenTranscriptPages`: chronological order + dedupe + skip-failed;
 *  - `getTranscriptNextPageParam`: more / none / page-cap / failed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import {
  flattenTranscriptPages,
  getTranscriptNextPageParam,
  MAX_TRANSCRIPT_PAGES,
  useTranscriptLiveSync,
  TRANSCRIPT_LIVE_FALLBACK_POLL_MS,
} from "../messages.js";
import { messagesKeys } from "../queryKeys.js";
import type { Result } from "@shared/ipc/result.js";
import type { MessagePage, SessionMessageDto } from "@shared/schemas/messages.js";

type TranscriptListener = (event: {
  type: string;
  sessionId: string;
  messageId: number;
  role: string;
  createdAt: string;
  messageType: string | null;
  correlationId: string | null;
}) => void;

let lastSubscribedListener: TranscriptListener | null = null;
const unsubscribeMock = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  lastSubscribedListener = null;
  unsubscribeMock.mockReset();
  // Stub the renderer-visible bridge surface — production wires this in
  // preload/agent/engine.ts.
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: {
        onTranscriptAppend: (cb: TranscriptListener) => {
          lastSubscribedListener = cb;
          return unsubscribeMock;
        },
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  // Cleanup window.vex stub.
  // @ts-expect-error — test cleanup
  delete window.vex;
});

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function sampleEvent(sessionId: string, messageId = 1) {
  return {
    type: "engine.transcript.append",
    sessionId,
    messageId,
    role: "assistant",
    createdAt: "2026-05-21T10:00:00.000Z",
    messageType: null,
    correlationId: null,
  };
}

describe("useTranscriptLiveSync", () => {
  it("subscribes to the engine bridge on mount and unsubscribes on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => useTranscriptLiveSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });

    expect(lastSubscribedListener).not.toBeNull();
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops on null / empty sessionId (no subscribe, no interval)", () => {
    const client = new QueryClient();
    renderHook(() => useTranscriptLiveSync(null), {
      wrapper: makeWrapper(client),
    });
    expect(lastSubscribedListener).toBeNull();
  });

  it("invalidates the session prefix on a matching transcriptAppend event", async () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useTranscriptLiveSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });

    lastSubscribedListener!(sampleEvent(SESSION_A));

    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: messagesKeys.forSession(SESSION_A),
    });
  });

  it("ignores events for a different session", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    renderHook(() => useTranscriptLiveSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });

    lastSubscribedListener!(sampleEvent(SESSION_B));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("runs the 30s fallback poll while the hook is mounted", () => {
    const client = new QueryClient();
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    const { unmount } = renderHook(() => useTranscriptLiveSync(SESSION_A), {
      wrapper: makeWrapper(client),
    });

    // No interval call yet.
    expect(invalidateSpy).not.toHaveBeenCalled();

    vi.advanceTimersByTime(TRANSCRIPT_LIVE_FALLBACK_POLL_MS);
    expect(invalidateSpy).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(TRANSCRIPT_LIVE_FALLBACK_POLL_MS);
    expect(invalidateSpy).toHaveBeenCalledTimes(2);

    unmount();
    vi.advanceTimersByTime(TRANSCRIPT_LIVE_FALLBACK_POLL_MS);
    // No more invalidations after unmount.
    expect(invalidateSpy).toHaveBeenCalledTimes(2);
  });

  it("prefix invalidation reaches the infinite transcript query for the same session", () => {
    // `messagesKeys.forSession(s)` must be a prefix of the infinite transcript
    // key (any limit) so a `transcriptAppend` invalidation reaches it under
    // `["messages", sessionId]`.
    const infinite50 = messagesKeys.infinite(SESSION_A, 50);
    const infinite100 = messagesKeys.infinite(SESSION_A, 100);
    const prefix = messagesKeys.forSession(SESSION_A);

    expect(infinite50.slice(0, prefix.length)).toEqual(prefix);
    expect(infinite100.slice(0, prefix.length)).toEqual(prefix);
  });
});

const ISO = "2026-05-26T10:00:00.000Z";

function msg(id: number): SessionMessageDto {
  return {
    id,
    sessionId: SESSION_A,
    role: "assistant",
    kind: "text",
    content: `m${id}`,
    createdAt: ISO,
    toolCallId: null,
    toolName: null,
    toolCalls: null,
    explorerRefs: null,
  };
}

function okPage(
  items: SessionMessageDto[],
  nextCursorId: number | null,
): Result<MessagePage> {
  return {
    ok: true,
    data: {
      items,
      nextCursor: nextCursorId === null ? null : { createdAt: ISO, id: nextCursorId },
      hasMore: nextCursorId !== null,
    },
  };
}

const errPage: Result<MessagePage> = {
  ok: false,
  error: {
    code: "internal.unexpected",
    domain: "data",
    message: "boom",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: "c",
  },
};

describe("flattenTranscriptPages", () => {
  it("returns chronological oldest→newest across pages (page 0 is newest)", () => {
    const page0 = okPage([msg(3), msg(4)], 2); // newest page
    const page1 = okPage([msg(1), msg(2)], null); // older page
    expect(flattenTranscriptPages([page0, page1]).map((m) => m.id)).toEqual([
      1, 2, 3, 4,
    ]);
  });

  it("de-duplicates ids that overlap across pages", () => {
    const page0 = okPage([msg(2), msg(3)], 2);
    const page1 = okPage([msg(1), msg(2)], null);
    expect(flattenTranscriptPages([page0, page1]).map((m) => m.id)).toEqual([
      1, 2, 3,
    ]);
  });

  it("skips failed pages without throwing", () => {
    expect(flattenTranscriptPages([okPage([msg(2)], 1), errPage]).map((m) => m.id)).toEqual([
      2,
    ]);
  });
});

describe("getTranscriptNextPageParam", () => {
  it("returns the next cursor when there is older history under the cap", () => {
    expect(getTranscriptNextPageParam(okPage([msg(1)], 1), 1)).toEqual({
      createdAt: ISO,
      id: 1,
    });
  });

  it("stops when the page has no older history", () => {
    expect(getTranscriptNextPageParam(okPage([msg(1)], null), 1)).toBeUndefined();
  });

  it("stops at the page cap", () => {
    expect(
      getTranscriptNextPageParam(okPage([msg(1)], 1), MAX_TRANSCRIPT_PAGES),
    ).toBeUndefined();
  });

  it("stops on a failed page", () => {
    expect(getTranscriptNextPageParam(errPage, 1)).toBeUndefined();
  });
});
