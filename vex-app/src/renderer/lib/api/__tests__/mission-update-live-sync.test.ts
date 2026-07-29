/**
 * `useMissionUpdateLiveSync` — the push that removes poll latency.
 *
 * Behaviour pinned here:
 *  - foreign-session events are ignored (one bus, every window);
 *  - `approval_enqueued` invalidates the per-session pending list only; the
 *    app-wide inbox is the session-agnostic hook's job (see
 *    `approvals-global-live-sync.test.ts`);
 *  - mission kinds invalidate draft + the session's diff prefix, and do NOT
 *    touch the approval caches (a model patch must not cost an approvals
 *    refetch);
 *  - the subscription is torn down on unmount.
 *
 * The fallback polls are asserted as CONSTANTS rather than by advancing timers:
 * the value is the contract (push-first, slow net), and a timer test would
 * just restate the implementation.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { MissionUpdateEvent } from "@shared/schemas/mission-update.js";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";

import {
  useMissionUpdateLiveSync,
  MISSION_LIVE_FALLBACK_POLL_MS,
} from "../mission.js";
import { RUNTIME_STATE_FALLBACK_POLL_MS } from "../runtime.js";
import { approvalsKeys, missionKeys } from "../queryKeys.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const OTHER_SESSION = "00000000-0000-4000-8000-0000000000ff";

type MissionUpdateListener = (event: MissionUpdateEvent) => void;

let listener: MissionUpdateListener | null = null;
const unsubscribeMock = vi.fn();
const onMissionUpdateMock = vi.fn((cb: MissionUpdateListener) => {
  listener = cb;
  return unsubscribeMock;
});

function event(
  overrides: Partial<MissionUpdateEvent> = {},
): MissionUpdateEvent {
  return {
    type: "engine.mission.update",
    sessionId: SESSION,
    missionId: "00000000-0000-4000-8000-0000000000aa",
    kind: "accepted",
    occurredAt: "2026-07-29T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  listener = null;
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      engine: makeEngineBridgeStub({ onMissionUpdate: onMissionUpdateMock }),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  };
}

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const invalidate = vi.spyOn(client, "invalidateQueries");
  const view = renderHook(() => useMissionUpdateLiveSync(SESSION), {
    wrapper: makeWrapper(client),
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

describe("useMissionUpdateLiveSync", () => {
  it("ignores an event for another session", () => {
    const { invalidate } = setup();
    act(() => listener?.(event({ sessionId: OTHER_SESSION })));
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("invalidates the SESSION inbox on approval_enqueued, and not the global one", () => {
    const { invalidate } = setup();
    act(() => listener?.(event({ kind: "approval_enqueued" })));

    const keys = invalidatedKeys(invalidate);
    expect(keys).toContainEqual(approvalsKeys.pending(SESSION));
    // `pendingAll` belongs to the session-agnostic `useGlobalApprovalsLiveSync`.
    // This hook filters foreign sessions, so owning the global key here would
    // leave a BACKGROUND session's approval waiting on the fallback poll.
    expect(keys).not.toContainEqual(approvalsKeys.pendingAll());
  });

  it.each(["accepted", "draft_updated", "readiness_changed"] as const)(
    "invalidates draft + diff on %s, and no approval cache",
    (kind) => {
      const { invalidate } = setup();
      act(() => listener?.(event({ kind })));

      const keys = invalidatedKeys(invalidate);
      expect(keys).toContainEqual(missionKeys.draft(SESSION));
      expect(keys).toContainEqual(missionKeys.diffsForSession(SESSION));
      expect(keys).not.toContainEqual(approvalsKeys.pending(SESSION));
      expect(keys).not.toContainEqual(approvalsKeys.pendingAll());
    },
  );

  it("unsubscribes on unmount", () => {
    const { view } = setup();
    expect(onMissionUpdateMock).toHaveBeenCalledTimes(1);
    view.unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });
});

describe("fallback poll cadences", () => {
  it("are slow nets, not the freshness path", () => {
    expect(MISSION_LIVE_FALLBACK_POLL_MS).toBe(60_000);
    expect(RUNTIME_STATE_FALLBACK_POLL_MS).toBe(60_000);
  });
});
