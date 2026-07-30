/**
 * `useGlobalApprovalsLiveSync` — the app-wide inbox must be push-first for
 * BACKGROUND sessions.
 *
 * This is the hook that makes the "AWAITING n" badge appear for an approval
 * raised by a session the user is not looking at. Every other push consumer is
 * session-scoped and drops foreign-session events, so if this one filtered too,
 * a background approval would sit invisible until the 60 s fallback poll — the
 * regression these tests exist to prevent.
 *
 * A chat-session approval is the sharp case: it produces no mission-level
 * control-state transition, so `approval_enqueued` is the only event that
 * reports it at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { MissionUpdateEvent } from "@shared/schemas/mission-update.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";

import { useGlobalApprovalsLiveSync } from "../approvals.js";
import { approvalsKeys } from "../queryKeys.js";

const ACTIVE_SESSION = "00000000-0000-4000-8000-000000000001";
const BACKGROUND_SESSION = "00000000-0000-4000-8000-0000000000ff";

type MissionUpdateListener = (event: MissionUpdateEvent) => void;
type ControlStateListener = (event: unknown) => void;

let missionListener: MissionUpdateListener | null = null;
let controlListener: ControlStateListener | null = null;
const offMissionUpdate = vi.fn();
const offControlState = vi.fn();

function event(overrides: Partial<MissionUpdateEvent> = {}): MissionUpdateEvent {
  return {
    type: "engine.mission.update",
    sessionId: BACKGROUND_SESSION,
    missionId: null,
    kind: "approval_enqueued",
    occurredAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  missionListener = null;
  controlListener = null;
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({
        onMissionUpdate: (cb) => {
          missionListener = cb;
          return offMissionUpdate;
        },
        onControlState: (cb) => {
          controlListener = cb as ControlStateListener;
          return offControlState;
        },
      }),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = renderHook(() => useGlobalApprovalsLiveSync(), {
    wrapper: ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client }, children),
  });
  invalidate.mockClear();
  return { invalidate, view };
}

function invalidatedKeys(invalidate: {
  readonly mock: { readonly calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): ReadonlyArray<unknown> {
  return invalidate.mock.calls.map(
    (call) => (call[0] as { queryKey: unknown }).queryKey,
  );
}

describe("useGlobalApprovalsLiveSync", () => {
  it("invalidates the inbox for an approval raised by a BACKGROUND session", () => {
    const { invalidate } = setup();
    act(() => missionListener?.(event({ sessionId: BACKGROUND_SESSION })));

    expect(invalidatedKeys(invalidate)).toContainEqual(
      approvalsKeys.pendingAll(),
    );
  });

  it("invalidates for a chat-session approval with no mission in scope", () => {
    const { invalidate } = setup();
    act(() => missionListener?.(event({ missionId: null })));

    expect(invalidatedKeys(invalidate)).toContainEqual(
      approvalsKeys.pendingAll(),
    );
  });

  it("does not filter by session — the active session works too", () => {
    const { invalidate } = setup();
    act(() => missionListener?.(event({ sessionId: ACTIVE_SESSION })));

    expect(invalidatedKeys(invalidate)).toContainEqual(
      approvalsKeys.pendingAll(),
    );
  });

  it.each(["accepted", "draft_updated", "readiness_changed"] as const)(
    "ignores %s — a draft change is not an approval",
    (kind) => {
      const { invalidate } = setup();
      act(() => missionListener?.(event({ kind })));

      expect(invalidate).not.toHaveBeenCalled();
    },
  );

  it("still refreshes on any control-state transition", () => {
    const { invalidate } = setup();
    act(() => controlListener?.({ sessionId: BACKGROUND_SESSION }));

    expect(invalidatedKeys(invalidate)).toContainEqual(
      approvalsKeys.pendingAll(),
    );
  });

  it("tears down BOTH subscriptions on unmount", () => {
    const { view } = setup();
    view.unmount();
    expect(offControlState).toHaveBeenCalledTimes(1);
    expect(offMissionUpdate).toHaveBeenCalledTimes(1);
  });
});
