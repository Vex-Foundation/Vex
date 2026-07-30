/**
 * Mission renderer hook invalidation tests (puzzle 04 phase 6).
 *
 * Verifies that mutation hooks fire `queryClient.invalidateQueries`
 * against the documented keys on success:
 *
 *   - acceptContract → missionKeys.draft + missionKeys.diff
 *   - start          → missionKeys.draft + missionKeys.diff + runtimeKeys.state
 *   - continue/stop  → runtimeKeys.state
 *   - renew          → missionKeys.all
 *   - setAutoRetry   → missionKeys.draft
 *
 * `useMissionLiveSync` (review-&-accept bar) mirrors
 * `useTranscriptLiveSync`/`useUsageLiveSync`: subscribes/unsubscribes,
 * ignores foreign-session events, invalidates draft + diff on a matching
 * transcript append, and runs a 30s fallback poll.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeEngineBridgeStub } from "../../../test/engine-bridge-stub.js";
import type { TranscriptAppendEvent } from "@shared/schemas/messages.js";
import { renderHook, act, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import {
  useAcceptMissionContract,
  useEditMission,
  useMissionContinue,
  useMissionLiveSync,
  useMissionRecover,
  useMissionRenew,
  useMissionRetry,
  useMissionStart,
  useMissionStop,
  useRenewableMissionSource,
  useSetAutoRetry,
  MISSION_LIVE_FALLBACK_POLL_MS,
} from "../mission.js";
import {
  missionKeys,
  runtimeKeys,
} from "../queryKeys.js";

const SESSION = "00000000-0000-4000-8000-000000000001";
const MISSION = "mission-1";

const mockMissionBridge = {
  getDraft: vi.fn(),
  updateDraft: vi.fn(),
  getDiff: vi.fn(),
  acceptContract: vi.fn(),
  start: vi.fn(),
  continue: vi.fn(),
  recover: vi.fn(),
  renew: vi.fn(),
  retry: vi.fn(),
  edit: vi.fn(),
  stop: vi.fn(),
  getRenewableSource: vi.fn(),
  setAutoRetry: vi.fn(),
};

type TranscriptListener = (event: TranscriptAppendEvent) => void;

let lastSubscribedListener: TranscriptListener | null = null;
const unsubscribeMock = vi.fn();
const onTranscriptAppendMock = vi.fn((cb: TranscriptListener) => {
  lastSubscribedListener = cb;
  return unsubscribeMock;
});

beforeEach(() => {
  vi.clearAllMocks();
  lastSubscribedListener = null;
  Object.defineProperty(window, "vex", {
    configurable: true,
    writable: true,
    value: {
      mission: mockMissionBridge,
      engine: makeEngineBridgeStub({
        onTranscriptAppend: onTranscriptAppendMock,
      }),
    },
  });
});

afterEach(() => {
  Reflect.deleteProperty(window, "vex");
});

function sampleTranscriptEvent(sessionId: string): TranscriptAppendEvent {
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

function makeWrapper(client: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return createElement(
      QueryClientProvider,
      { client },
      children,
    );
  };
}

function makeClient() {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const invalidateSpy = vi.spyOn(client, "invalidateQueries");
  return { client, invalidateSpy };
}

describe("mission hook invalidations", () => {
  it("useAcceptMissionContract invalidates draft + diff for the session", async () => {
    mockMissionBridge.acceptContract.mockResolvedValue({
      ok: true,
      data: { outcome: "accepted" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useAcceptMissionContract(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: SESSION,
        missionId: MISSION,
        contractHash: "a".repeat(64),
      });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: missionKeys.draft(SESSION),
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.diff(SESSION, MISSION),
    });
  });

  it("useMissionStart invalidates draft + diff + runtime state", async () => {
    mockMissionBridge.start.mockResolvedValue({
      ok: true,
      data: { outcome: "dispatched", missionRunId: "run-1", sessionId: SESSION },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useMissionStart(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: SESSION,
        missionId: MISSION,
      });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: runtimeKeys.state(SESSION),
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.draft(SESSION),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.diff(SESSION, MISSION),
    });
    // Phase 7 — start lifts source out of terminal-latest state.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.renewableSource(SESSION),
    });
  });

  it("useSetAutoRetry invalidates the draft on success", async () => {
    mockMissionBridge.setAutoRetry.mockResolvedValue({
      ok: true,
      data: { outcome: "updated", enabled: true },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useSetAutoRetry(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: SESSION,
        missionId: MISSION,
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: missionKeys.draft(SESSION),
      });
    });
  });

  it("useSetAutoRetry resyncs the draft even when the engine refuses (blocked_permission)", async () => {
    // onSettled (not onSuccess) → a server refusal still snaps the toggle
    // back to the persisted value.
    mockMissionBridge.setAutoRetry.mockResolvedValue({
      ok: true,
      data: { outcome: "blocked_permission" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useSetAutoRetry(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: SESSION,
        missionId: MISSION,
        enabled: true,
      });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: missionKeys.draft(SESSION),
      });
    });
  });

  it("useMissionRetry invalidates runtime state", async () => {
    mockMissionBridge.retry.mockResolvedValue({
      ok: true,
      data: { outcome: "resumed", runId: "run-1" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useMissionRetry(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: runtimeKeys.state(SESSION),
      });
    });
  });

  it("useEditMission invalidates draft + runtime + renewable source", async () => {
    mockMissionBridge.edit.mockResolvedValue({
      ok: true,
      data: { outcome: "stopped" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useEditMission(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: missionKeys.draft(SESSION),
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: runtimeKeys.state(SESSION),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.renewableSource(SESSION),
    });
  });

  it("useMissionContinue invalidates runtime state only", async () => {
    mockMissionBridge.continue.mockResolvedValue({
      ok: true,
      data: { outcome: "no_active_run" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useMissionContinue(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: runtimeKeys.state(SESSION),
      });
    });
    expect(invalidateSpy).not.toHaveBeenCalledWith({
      queryKey: missionKeys.draft(SESSION),
    });
  });

  it("useMissionStop invalidates runtime state only", async () => {
    mockMissionBridge.stop.mockResolvedValue({
      ok: true,
      data: { outcome: "no_active_run" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useMissionStop(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: runtimeKeys.state(SESSION),
      });
    });
    // Phase 7 — stop flips mission_run terminal → renewable source shifts.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.renewableSource(SESSION),
    });
  });

  it("useMissionRecover invalidates draft + runtime state", async () => {
    mockMissionBridge.recover.mockResolvedValue({
      ok: true,
      data: { outcome: "no_failed_run" },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useMissionRecover(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({ sessionId: SESSION });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: missionKeys.draft(SESSION),
      });
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: runtimeKeys.state(SESSION),
    });
    // Phase 7 — recover replaces latest mission_run → terminal-latest may shift.
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.renewableSource(SESSION),
    });
  });

  it("useMissionRenew invalidates missionKeys.all (covers old draft + new mission)", async () => {
    mockMissionBridge.renew.mockResolvedValue({
      ok: true,
      data: {
        outcome: "renewed",
        newMissionId: "mission-2",
        sourceMissionId: MISSION,
      },
    });
    const { client, invalidateSpy } = makeClient();
    const { result } = renderHook(() => useMissionRenew(), {
      wrapper: makeWrapper(client),
    });
    await act(async () => {
      await result.current.mutateAsync({
        sessionId: SESSION,
        previousMissionId: MISSION,
      });
    });
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({
        queryKey: missionKeys.all,
      });
    });
  });

  it("useRenewableMissionSource queries the bridge with the session", async () => {
    mockMissionBridge.getRenewableSource.mockResolvedValue({
      ok: true,
      data: { missionId: MISSION },
    });
    const { client } = makeClient();
    const { result } = renderHook(() => useRenewableMissionSource(SESSION), {
      wrapper: makeWrapper(client),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(mockMissionBridge.getRenewableSource).toHaveBeenCalledWith({
      sessionId: SESSION,
    });
    if (result.current.data?.ok === true) {
      expect(result.current.data.data).toEqual({ missionId: MISSION });
    }
  });

  it("useRenewableMissionSource is disabled when sessionId is null", () => {
    const { client } = makeClient();
    const { result } = renderHook(() => useRenewableMissionSource(null), {
      wrapper: makeWrapper(client),
    });
    expect(result.current.fetchStatus).toBe("idle");
    expect(mockMissionBridge.getRenewableSource).not.toHaveBeenCalled();
  });
});

describe("useMissionLiveSync", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const SESSION_B = "00000000-0000-4000-8000-000000000002";

  it("subscribes on mount and unsubscribes on unmount", () => {
    const { client } = makeClient();
    const { unmount } = renderHook(() => useMissionLiveSync(SESSION), {
      wrapper: makeWrapper(client),
    });
    expect(lastSubscribedListener).not.toBeNull();
    unmount();
    expect(unsubscribeMock).toHaveBeenCalledTimes(1);
  });

  it("no-ops on null sessionId (no subscribe)", () => {
    const { client } = makeClient();
    renderHook(() => useMissionLiveSync(null), { wrapper: makeWrapper(client) });
    expect(lastSubscribedListener).toBeNull();
    expect(onTranscriptAppendMock).not.toHaveBeenCalled();
  });

  it("invalidates draft + diff for the session on a matching transcript-append event", () => {
    const { client, invalidateSpy } = makeClient();
    renderHook(() => useMissionLiveSync(SESSION), {
      wrapper: makeWrapper(client),
    });

    lastSubscribedListener!(sampleTranscriptEvent(SESSION));

    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.draft(SESSION),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.diffsForSession(SESSION),
    });
  });

  it("ignores events for a different session", () => {
    const { client, invalidateSpy } = makeClient();
    renderHook(() => useMissionLiveSync(SESSION), {
      wrapper: makeWrapper(client),
    });

    lastSubscribedListener!(sampleTranscriptEvent(SESSION_B));

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  it("runs the 30s fallback poll while mounted (draft + diff, repeated ticks), stops after unmount", () => {
    const { client, invalidateSpy } = makeClient();
    const { unmount } = renderHook(() => useMissionLiveSync(SESSION), {
      wrapper: makeWrapper(client),
    });

    expect(invalidateSpy).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(MISSION_LIVE_FALLBACK_POLL_MS);
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.draft(SESSION),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: missionKeys.diffsForSession(SESSION),
    });
    const callsAfterFirstTick = invalidateSpy.mock.calls.length;

    act(() => {
      vi.advanceTimersByTime(MISSION_LIVE_FALLBACK_POLL_MS);
    });
    expect(invalidateSpy.mock.calls.length).toBeGreaterThan(callsAfterFirstTick);

    const callsAfterSecondTick = invalidateSpy.mock.calls.length;
    unmount();
    act(() => {
      vi.advanceTimersByTime(MISSION_LIVE_FALLBACK_POLL_MS);
    });
    expect(invalidateSpy.mock.calls.length).toBe(callsAfterSecondTick);
  });

  it("mounts no interval handle for a null session (no leaked timer)", () => {
    const { client, invalidateSpy } = makeClient();
    renderHook(() => useMissionLiveSync(null), { wrapper: makeWrapper(client) });
    act(() => {
      vi.advanceTimersByTime(MISSION_LIVE_FALLBACK_POLL_MS * 2);
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});
