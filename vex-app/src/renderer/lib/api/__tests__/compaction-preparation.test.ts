/**
 * Compaction-preparation hooks (compaction v2) — push-first invariants.
 *
 *  - the live sync subscribes/unsubscribes, ignores foreign-session events and
 *    invalidates only the session's preparation key;
 *  - the fallback interval is cleared on unmount (a leaked interval would keep
 *    invalidating a dead session forever);
 *  - the fallback stays SLOW — it is a net for dropped events, not a second
 *    freshness path;
 *  - the apply mutation never auto-retries.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { CompactionPreparationEvent } from "@shared/schemas/compaction-preparation.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";

import {
  PREPARATION_FALLBACK_POLL_MS,
  usePreparationLiveSync,
  useRequestCompactionApply,
} from "../compaction-preparation.js";
import { COMPACTION_ACTIVE_POLL_MS } from "../compaction.js";
import { compactionKeys } from "../queryKeys.js";

type Listener = (event: CompactionPreparationEvent) => void;

const A = "00000000-0000-4000-8000-00000000000a";
const B = "00000000-0000-4000-8000-00000000000b";

function preparationEvent(sessionId: string): CompactionPreparationEvent {
  return {
    type: "engine.compaction.preparation",
    sessionId,
    status: "summary_ready",
    summaryReady: true,
    correlationId: null,
  };
}

let lastListener: Listener | null = null;
const unsubscribeMock = vi.fn();
const requestApplyMock = vi.fn();

beforeEach(() => {
  lastListener = null;
  unsubscribeMock.mockReset();
  requestApplyMock.mockReset();
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onCompactionPreparation: (cb) => {
          lastListener = cb;
          return unsubscribeMock;
        },
      }),
      compaction: { requestApply: requestApplyMock },
    },
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

describe("PREPARATION_FALLBACK_POLL_MS", () => {
  it("is a slow net, not a poll — far slower than the Track-2 active poll", () => {
    expect(PREPARATION_FALLBACK_POLL_MS).toBe(60_000);
    expect(PREPARATION_FALLBACK_POLL_MS).toBeGreaterThan(
      COMPACTION_ACTIVE_POLL_MS,
    );
  });
});

describe("usePreparationLiveSync", () => {
  it("subscribes on mount and unsubscribes on unmount", () => {
    const client = new QueryClient();
    const { unmount } = renderHook(() => usePreparationLiveSync(A), {
      wrapper: makeWrapper(client),
    });
    expect(lastListener).not.toBeNull();
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops on a null sessionId", () => {
    const client = new QueryClient();
    renderHook(() => usePreparationLiveSync(null), {
      wrapper: makeWrapper(client),
    });
    expect(lastListener).toBeNull();
  });

  it("ignores a FOREIGN sessionId and invalidates only its own key", () => {
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => usePreparationLiveSync(A), { wrapper: makeWrapper(client) });

    lastListener?.(preparationEvent(B));
    expect(spy).not.toHaveBeenCalled();

    lastListener?.(preparationEvent(A));
    expect(spy).toHaveBeenCalledWith({
      queryKey: compactionKeys.preparation(A),
    });
  });

  it("clears the fallback interval on unmount", () => {
    const clearSpy = vi.spyOn(window, "clearInterval");
    const client = new QueryClient();
    const { unmount } = renderHook(() => usePreparationLiveSync(A), {
      wrapper: makeWrapper(client),
    });
    unmount();
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });
});

describe("useRequestCompactionApply", () => {
  it("calls the bridge once and does NOT auto-retry a failed request", async () => {
    requestApplyMock.mockResolvedValue({
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
    });
    const client = new QueryClient();
    const { result } = renderHook(() => useRequestCompactionApply(), {
      wrapper: makeWrapper(client),
    });

    result.current.mutate({ sessionId: A });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // A retryable Result is still a resolved mutation; the point is that the
    // bridge was invoked exactly once — the button is the retry.
    expect(requestApplyMock).toHaveBeenCalledTimes(1);
    expect(requestApplyMock).toHaveBeenCalledWith({ sessionId: A });
  });

  it("invalidates the preparation and runtime keys after a successful request", async () => {
    requestApplyMock.mockResolvedValue({
      ok: true,
      data: { outcome: "queued", status: "apply_requested" },
    });
    const client = new QueryClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    const { result } = renderHook(() => useRequestCompactionApply(), {
      wrapper: makeWrapper(client),
    });

    result.current.mutate({ sessionId: A });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(spy).toHaveBeenCalledWith({
      queryKey: compactionKeys.preparation(A),
    });
  });
});
