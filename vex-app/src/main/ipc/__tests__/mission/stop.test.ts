/**
 * mission.stop / runStopDispatch tests — the Stop fix.
 *
 * A `running` run is stopped gracefully (enqueue a stop_terminal request the
 * runner observes). A PAUSED run has no runner to observe that request, so it
 * is aborted DIRECTLY via the engine (finalize → cancelled, reject approvals).
 * Only the stop handler is registered for isolation; the engine + repo calls
 * are mocked.
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
const mockEnqueueOperatorStopRequest = vi.fn();
const mockAbortActiveMissionForSession = vi.fn();

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
vi.mock("../../runtime/_ensure-engine-db-url.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../runtime/_emit-control-state.js", () => ({
  emitControlStateAfterChange: (...a: unknown[]) =>
    mockEmitControlStateAfterChange(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  enqueueOperatorStopRequest: (...a: unknown[]) =>
    mockEnqueueOperatorStopRequest(...a),
}));
vi.mock("@vex-agent/engine/index.js", () => ({
  abortActiveMissionForSession: (...a: unknown[]) =>
    mockAbortActiveMissionForSession(...a),
}));

const { registerMissionStopHandler } = await import("../../mission/stop.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.stop);
  if (!handler) throw new Error("No handler for mission.stop");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as { ok: boolean; data?: { outcome: string }; error?: { code: string } };
}

function activeState(status: string, leaseActive = true) {
  return {
    ok: true,
    data: { hasActiveRun: true, missionRunId: "run-1", status, leaseActive },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  electronMock.__handlers.clear();
  registerMissionStopHandler();
});

describe("mission.stop (runStopDispatch)", () => {
  it("enqueues a graceful stop for a running run with a LIVE lease (queued, no abort)", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(
      activeState("running", true),
    );
    mockEnqueueOperatorStopRequest.mockResolvedValueOnce({
      outcome: "queued",
      requestId: "22222222-2222-4222-8222-222222222222",
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data?.outcome).toBe("queued");
    expect(mockEnqueueOperatorStopRequest).toHaveBeenCalledTimes(1);
    expect(mockAbortActiveMissionForSession).not.toHaveBeenCalled();
  });

  it("aborts a running run whose lease is NOT active — no live runner would observe a queued stop", async () => {
    // Regression: a run can be status='running' with leaseActive=false
    // (parked between autonomous mission slices, or an expired/released
    // lease). Enqueue-only strands the stop forever, leaving the session
    // un-stoppable/un-deletable (issue #12).
    mockGetActiveRunForSession.mockResolvedValueOnce(
      activeState("running", false),
    );
    mockAbortActiveMissionForSession.mockResolvedValueOnce({
      aborted: true,
      finalStatus: "cancelled",
      rejectedApprovals: 0,
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "stopped" });
    expect(mockAbortActiveMissionForSession).toHaveBeenCalledWith(SESSION);
    expect(mockEnqueueOperatorStopRequest).not.toHaveBeenCalled();
  });

  it("aborts a paused_error run directly (stopped, no enqueue)", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("paused_error"));
    mockAbortActiveMissionForSession.mockResolvedValueOnce({
      aborted: true,
      finalStatus: "cancelled",
      rejectedApprovals: 0,
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "stopped" });
    expect(mockAbortActiveMissionForSession).toHaveBeenCalledWith(SESSION);
    expect(mockEnqueueOperatorStopRequest).not.toHaveBeenCalled();
  });

  it("aborts a paused_approval run (engine rejects pending approvals)", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(
      activeState("paused_approval"),
    );
    mockAbortActiveMissionForSession.mockResolvedValueOnce({
      aborted: true,
      finalStatus: "cancelled",
      rejectedApprovals: 2,
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "stopped" });
    expect(mockAbortActiveMissionForSession).toHaveBeenCalledWith(SESSION);
  });

  it("reports no_active_run for an already-terminal abort race (aborted:false)", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("paused_wake"));
    mockAbortActiveMissionForSession.mockResolvedValueOnce({
      aborted: false,
      finalStatus: "cancelled",
      rejectedApprovals: 0,
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "no_active_run" });
  });

  it("returns no_active_run when there is no active run", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { hasActiveRun: false, missionRunId: null, status: null },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "no_active_run" });
    expect(mockAbortActiveMissionForSession).not.toHaveBeenCalled();
    expect(mockEnqueueOperatorStopRequest).not.toHaveBeenCalled();
  });
});
