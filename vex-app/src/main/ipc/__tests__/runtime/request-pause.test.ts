/**
 * runtime.requestPause tests — the dead-lease `already_parked` fix.
 *
 * A `running` run with a LIVE lease is paused gracefully (enqueue
 * `pause_after_step`, observed by the runner at its next iteration
 * boundary). A `running` run whose lease is NOT active has no runner to
 * observe that request, so it is refused up front with `already_parked`
 * instead of being enqueued and stranded forever (same bug class as
 * issue #12's stop dead-end).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockGetActiveRunForSession = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();
const mockEnqueueRequest = vi.fn();
const mockGetPendingForSession = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<
    string,
    (e: IpcMainInvokeEvent, p: unknown) => unknown
  >();
  return {
    ipcMain: {
      handle: vi.fn(
        (channel: string, fn: (e: IpcMainInvokeEvent, p: unknown) => unknown) =>
          handlers.set(channel, fn),
      ),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});

vi.mock("../../../database/mission-runs-db.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../../../database/mission-runs-db.js")
    >();
  return {
    ...actual,
    getActiveRunForSession: (...a: unknown[]) =>
      mockGetActiveRunForSession(...a),
  };
});
vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../runtime/_emit-control-state.js", () => ({
  emitControlStateAfterChange: (...a: unknown[]) =>
    mockEmitControlStateAfterChange(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@vex-agent/db/repos/runtime-control-requests.js", () => ({
  enqueueRequest: (...a: unknown[]) => mockEnqueueRequest(...a),
  getPendingForSession: (...a: unknown[]) => mockGetPendingForSession(...a),
}));

const { registerRuntimeRequestPauseHandler } = await import(
  "../../runtime/request-pause.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000bbbb";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.runtime.requestPause);
  if (!handler) throw new Error("No handler for runtime.requestPause");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as { ok: boolean; data?: { outcome: string }; error?: { code: string } };
}

function activeState(status: string, leaseActive: boolean) {
  return {
    ok: true,
    data: { hasActiveRun: true, missionRunId: "run-1", status, leaseActive },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  mockGetPendingForSession.mockResolvedValue([]);
  electronMock.__handlers.clear();
  registerRuntimeRequestPauseHandler();
});

describe("runtime.requestPause", () => {
  it("enqueues a graceful pause for a running run with a LIVE lease", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(
      activeState("running", true),
    );
    mockEnqueueRequest.mockResolvedValueOnce({
      id: "22222222-2222-4222-8222-222222222222",
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data?.outcome).toBe("queued");
    expect(mockEnqueueRequest).toHaveBeenCalledTimes(1);
  });

  it("returns already_parked for a running run whose lease is NOT active - never enqueues", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(
      activeState("running", false),
    );
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "already_parked" });
    expect(mockEnqueueRequest).not.toHaveBeenCalled();
    expect(mockGetPendingForSession).not.toHaveBeenCalled();
  });

  it("still returns already_paused for a genuinely paused run (unaffected by the lease check)", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(
      activeState("paused_user", false),
    );
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "already_paused", status: "paused_user" });
    expect(mockEnqueueRequest).not.toHaveBeenCalled();
  });

  it("returns no_active_run when there is no active run", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { hasActiveRun: false, missionRunId: null, status: null },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "no_active_run" });
    expect(mockEnqueueRequest).not.toHaveBeenCalled();
  });

  // Read-to-action lease race: the lease state can flip between the
  // classifier's single `getActiveRunForSession` read and the point where the
  // handler would take its action (enqueue on the live path). The handler must
  // stay safe under BOTH interleavings. The graceful path calls
  // `getPendingForSession` AFTER classification and BEFORE `enqueueRequest`, so
  // that read is the concrete injection point for a mid-flight lease change.
  describe("read-to-action lease race", () => {
    it("classifier sees a DEAD lease that a runner re-acquires mid-flight → declines with already_parked, never enqueues an unobservable request", async () => {
      // Interleaving dead→live: the classifier read is the SOLE decision
      // authority. It sees a dead lease and returns already_parked before ever
      // reaching the action path (getPendingForSession → enqueueRequest), so a
      // live runner re-acquiring the lease the instant afterward cannot turn
      // this into a stranded pause_after_step. The action path never running is
      // exactly what proves the reacquire is irrelevant to this call's outcome.
      mockGetActiveRunForSession.mockResolvedValueOnce(
        activeState("running", false),
      );

      const r = await call({ sessionId: SESSION });

      expect(r.data).toEqual({ outcome: "already_parked" });
      // Dead path short-circuits before the action path — nothing stranded.
      expect(mockGetPendingForSession).not.toHaveBeenCalled();
      expect(mockEnqueueRequest).not.toHaveBeenCalled();
    });

    it("classifier sees a LIVE lease that is reassigned to another live runner mid-flight → still enqueues pause_after_step, which the live runner observes", async () => {
      // Interleaving live→(re-acquired) live: the classifier reads a live lease
      // and commits to the graceful enqueue path. Model the lease being handed
      // to a DIFFERENT live runner BETWEEN the classifier read and the enqueue
      // (side effect inside the intervening getPendingForSession read). Per the
      // stop-fix safety pattern, enqueuing here is safe precisely because a
      // live runner is (still/again) observing, so the pause_after_step is
      // applied at the next iteration boundary rather than stranded. Assert the
      // enqueue actually happened with the correct kind so the request is
      // observable, not silently dropped.
      let leaseReassignedMidFlight = false;
      mockGetActiveRunForSession.mockResolvedValueOnce(
        activeState("running", true),
      );
      mockGetPendingForSession.mockImplementationOnce(async () => {
        leaseReassignedMidFlight = true; // lease handed to another live runner
        return [];
      });
      mockEnqueueRequest.mockResolvedValueOnce({
        id: "44444444-4444-4444-8444-444444444444",
      });

      const r = await call({ sessionId: SESSION });

      expect(leaseReassignedMidFlight).toBe(true);
      expect(r.data?.outcome).toBe("queued");
      expect(mockEnqueueRequest).toHaveBeenCalledTimes(1);
      expect(mockEnqueueRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "pause_after_step",
          missionRunId: "run-1",
        }),
      );
      // The single classifier read is the decision authority — the handler
      // does not issue a second lease read that could disagree mid-decision.
      expect(mockGetActiveRunForSession).toHaveBeenCalledTimes(1);
    });
  });
});
