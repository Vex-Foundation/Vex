/**
 * Tests for the app-wide approvals hooks (`usePendingApprovalsAll` +
 * `useGlobalApprovalsLiveSync`) that back the DESK RULE global inbox.
 *
 * Mirrors `runtime.test.ts`, but the global live-sync has NO session filter:
 *  - `useGlobalApprovalsLiveSync` subscribes to `onControlState` on mount;
 *  - ANY session's event invalidates `approvalsKeys.pendingAll()` (unlike the
 *    per-session `useControlStateLiveSync`, which ignores foreign sessions);
 *  - unmount unsubscribes;
 *  - `usePendingApprovalsAll` calls `window.vex.approvals.listPendingAll({})`
 *    and forwards `refetchInterval` (opt-in poll).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement, type ReactNode } from "react";

import {
  useGlobalApprovalsLiveSync,
  usePendingApprovalsAll,
} from "../approvals.js";
import { approvalsKeys } from "../queryKeys.js";
import {
  CONTROL_STATE_EVENT_TYPE,
  type ControlStateEvent,
} from "@shared/schemas/runtime.js";

const SESSION_A = "00000000-0000-4000-8000-00000000000a";
const SESSION_B = "00000000-0000-4000-8000-00000000000b";

type ControlCb = (event: ControlStateEvent) => void;

let controlCb: ControlCb | null;
const off = vi.fn();
const onControlState = vi.fn((cb: ControlCb) => {
  controlCb = cb;
  return off;
});
const listPendingAll = vi.fn();

function controlEvent(sessionId: string): ControlStateEvent {
  return {
    type: CONTROL_STATE_EVENT_TYPE,
    sessionId,
    missionRunId: "run-1",
    runStatus: "paused_approval",
    stopReason: null,
    pendingControlKind: null,
    leaseActive: false,
    leaseExpiresAt: null,
    correlationId: null,
  };
}

beforeEach(() => {
  controlCb = null;
  off.mockReset();
  onControlState.mockClear();
  listPendingAll.mockReset();
  listPendingAll.mockResolvedValue({ ok: true, data: [] });
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({ onControlState }),
      approvals: { listPendingAll },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  // @ts-expect-error — test cleanup
  delete window.vex;
});

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { readonly children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function freshClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function keysOf(
  spy: ReturnType<typeof vi.spyOn>,
): ReadonlyArray<readonly unknown[]> {
  const calls = spy.mock.calls as ReadonlyArray<readonly unknown[]>;
  return calls.map((call): readonly unknown[] => {
    const arg = call[0] as { queryKey?: readonly unknown[] } | undefined;
    return arg?.queryKey ?? [];
  });
}

function hasKey(
  spy: ReturnType<typeof vi.spyOn>,
  key: readonly unknown[],
): boolean {
  const target = JSON.stringify(key);
  return keysOf(spy).some((k) => JSON.stringify(k) === target);
}

describe("useGlobalApprovalsLiveSync", () => {
  it("subscribes on mount", () => {
    const client = freshClient();
    renderHook(() => useGlobalApprovalsLiveSync(), {
      wrapper: makeWrapper(client),
    });
    expect(onControlState).toHaveBeenCalledTimes(1);
    expect(controlCb).not.toBeNull();
  });

  it("invalidates pendingAll on ANY session's event (no session filter)", () => {
    const client = freshClient();
    const spy = vi.spyOn(client, "invalidateQueries");
    renderHook(() => useGlobalApprovalsLiveSync(), {
      wrapper: makeWrapper(client),
    });

    // A foreign session (not the mounted one) still refreshes the global inbox.
    controlCb?.(controlEvent(SESSION_B));
    expect(hasKey(spy, approvalsKeys.pendingAll())).toBe(true);

    // And a second, different session too.
    spy.mockClear();
    controlCb?.(controlEvent(SESSION_A));
    expect(hasKey(spy, approvalsKeys.pendingAll())).toBe(true);
  });

  it("unsubscribes on unmount", () => {
    const client = freshClient();
    const { unmount } = renderHook(() => useGlobalApprovalsLiveSync(), {
      wrapper: makeWrapper(client),
    });
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});

describe("usePendingApprovalsAll", () => {
  it("calls the bridge listPendingAll with the empty input", async () => {
    const client = freshClient();
    renderHook(() => usePendingApprovalsAll(), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(listPendingAll).toHaveBeenCalledWith({}));
  });

  it("forwards refetchInterval so the bridge is polled again", async () => {
    const client = freshClient();
    renderHook(() => usePendingApprovalsAll({ refetchInterval: 20 }), {
      wrapper: makeWrapper(client),
    });
    await waitFor(
      () => expect(listPendingAll.mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 2000 },
    );
  });
});
