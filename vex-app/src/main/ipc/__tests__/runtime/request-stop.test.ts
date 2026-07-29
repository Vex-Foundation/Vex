/**
 * `runtime.requestStop` tests — previously an untested channel even though it
 * shares `runStopDispatch` with `mission.stop`.
 *
 * The behavior that matters here is the two-step live-lease stop:
 *   1. the run-scoped `stop_terminal` request is persisted FIRST (durable
 *      truth — a crash after this still leaves the stop recoverable);
 *   2. THEN the in-process `AbortController` is fired best-effort, so the
 *      operator's Stop cancels an in-flight provider call instead of waiting
 *      for the next iteration boundary.
 * A queued request alone was inert against a long generation, which is the
 * defect this pins.
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
const mockSignalMissionRunAbortLocal = vi.fn();

/** Ordered trace of the two side effects, to pin "durable write first". */
const callOrder: string[] = [];

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
// The insert moved off the bare repo and onto the engine's operator-stop
// boundary, which writes the row under the session control lock so it is
// ordered against the approval enqueue and the approved money-path dispatch.
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  enqueueOperatorStopRequest: (...a: unknown[]) => {
    callOrder.push("enqueueOperatorStopRequest");
    return mockEnqueueOperatorStopRequest(...a);
  },
}));
vi.mock("@vex-agent/engine/index.js", () => ({
  abortActiveMissionForSession: (...a: unknown[]) =>
    mockAbortActiveMissionForSession(...a),
  signalMissionRunAbortLocal: (...a: unknown[]) => {
    callOrder.push("signalMissionRunAbortLocal");
    return mockSignalMissionRunAbortLocal(...a);
  },
}));

const { registerRuntimeRequestStopHandler } = await import(
  "../../runtime/request-stop.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000cccc";
const REQUEST_ID = "33333333-3333-4333-8333-333333333333";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.runtime.requestStop);
  if (!handler) throw new Error("No handler for runtime.requestStop");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: REQUEST_ID,
    payload,
  })) as {
    ok: boolean;
    data?: { outcome: string; requestId?: string };
    error?: { code: string };
  };
}

function activeState(status: string, leaseActive = true) {
  return {
    ok: true,
    data: {
      hasActiveRun: true,
      missionRunId: "run-1",
      status,
      leaseActive,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  callOrder.length = 0;
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  mockSignalMissionRunAbortLocal.mockReturnValue(true);
  electronMock.__handlers.clear();
  registerRuntimeRequestStopHandler();
});

describe("runtime.requestStop", () => {
  it("persists the run-scoped request FIRST, then fires the local abort", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("running", true));
    mockEnqueueOperatorStopRequest.mockResolvedValueOnce({
      outcome: "queued",
      requestId: "44444444-4444-4444-8444-444444444444",
    });

    const r = await call({ sessionId: SESSION });

    expect(r.data?.outcome).toBe("queued");
    // Durable truth before the best-effort in-process signal: a crash between
    // the two must still leave the stop recoverable.
    expect(callOrder).toEqual(["enqueueOperatorStopRequest", "signalMissionRunAbortLocal"]);
    expect(mockEnqueueOperatorStopRequest).toHaveBeenCalledWith({
      sessionId: SESSION,
      // Run-scoped so the engine can clear it as stale if a LATER run
      // observes it.
      missionRunId: "run-1",
      correlationId: REQUEST_ID,
    });
    expect(mockSignalMissionRunAbortLocal).toHaveBeenCalledWith("run-1");
    expect(mockAbortActiveMissionForSession).not.toHaveBeenCalled();
  });

  it("still reports queued when no controller lives in this process", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("running", true));
    mockEnqueueOperatorStopRequest.mockResolvedValueOnce({
      outcome: "queued",
      requestId: "44444444-4444-4444-8444-444444444444",
    });
    mockSignalMissionRunAbortLocal.mockReturnValue(false);

    const r = await call({ sessionId: SESSION });

    // The durable request is what makes the stop land; the local signal only
    // buys latency.
    expect(r.data?.outcome).toBe("queued");
  });

  it("a throwing local abort does not fail the stop (best-effort)", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("running", true));
    mockEnqueueOperatorStopRequest.mockResolvedValueOnce({
      outcome: "queued",
      requestId: "44444444-4444-4444-8444-444444444444",
    });
    mockSignalMissionRunAbortLocal.mockImplementation(() => {
      throw new Error("registry exploded");
    });

    const r = await call({ sessionId: SESSION });

    expect(r.ok).toBe(true);
    expect(r.data?.outcome).toBe("queued");
    expect(mockEmitControlStateAfterChange).toHaveBeenCalled();
  });

  it("does not strand a stop on a run that went terminal under the boundary lock", async () => {
    // The status read above is unlocked, so the run can go terminal between it
    // and the insert. The engine's boundary re-checks under the run's row lock
    // and refuses; queueing there would leave a request no runner will observe
    // (issue #12's failure mode through a different door).
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("running", true));
    mockEnqueueOperatorStopRequest.mockResolvedValueOnce({
      outcome: "already_terminal",
      runStatus: "completed",
    });

    const r = await call({ sessionId: SESSION });

    expect(r.ok).toBe(true);
    expect(r.data?.outcome).toBe("already_terminal");
    // No point signalling an AbortController for a run that already ended.
    expect(mockSignalMissionRunAbortLocal).not.toHaveBeenCalled();
    expect(mockEmitControlStateAfterChange).toHaveBeenCalled();
  });

  it("reports no_active_run when the run vanished before the locked insert", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("running", true));
    mockEnqueueOperatorStopRequest.mockResolvedValueOnce({
      outcome: "run_not_found",
    });

    const r = await call({ sessionId: SESSION });

    expect(r.ok).toBe(true);
    expect(r.data?.outcome).toBe("no_active_run");
    expect(mockSignalMissionRunAbortLocal).not.toHaveBeenCalled();
  });

  it("does NOT enqueue or signal for a dead-lease running run — aborts directly", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("running", false));
    mockAbortActiveMissionForSession.mockResolvedValueOnce({
      aborted: true,
      finalStatus: "cancelled",
      rejectedApprovals: 0,
    });

    const r = await call({ sessionId: SESSION });

    expect(r.data).toEqual({ outcome: "stopped" });
    expect(mockEnqueueOperatorStopRequest).not.toHaveBeenCalled();
    expect(mockSignalMissionRunAbortLocal).not.toHaveBeenCalled();
  });

  it("aborts a paused run directly", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce(activeState("paused_approval"));
    mockAbortActiveMissionForSession.mockResolvedValueOnce({
      aborted: true,
      finalStatus: "cancelled",
      rejectedApprovals: 1,
    });

    const r = await call({ sessionId: SESSION });

    expect(r.data).toEqual({ outcome: "stopped" });
    expect(mockAbortActiveMissionForSession).toHaveBeenCalledWith(SESSION);
  });

  it.each(["completed", "failed", "stopped", "cancelled"])(
    "reports already_terminal for %s without touching the engine",
    async (status) => {
      mockGetActiveRunForSession.mockResolvedValueOnce(activeState(status, false));

      const r = await call({ sessionId: SESSION });

      expect(r.data).toEqual({ outcome: "already_terminal", status });
      expect(mockEnqueueOperatorStopRequest).not.toHaveBeenCalled();
      expect(mockSignalMissionRunAbortLocal).not.toHaveBeenCalled();
      expect(mockAbortActiveMissionForSession).not.toHaveBeenCalled();
    },
  );

  it("returns no_active_run when the session has no run", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { hasActiveRun: false, missionRunId: null, status: null },
    });

    const r = await call({ sessionId: SESSION });

    expect(r.data).toEqual({ outcome: "no_active_run" });
    expect(mockSignalMissionRunAbortLocal).not.toHaveBeenCalled();
  });

  it("rejects a non-uuid sessionId at the schema boundary", async () => {
    const r = await call({ sessionId: "not-a-uuid" });
    expect(r.ok).toBe(false);
    expect(mockGetActiveRunForSession).not.toHaveBeenCalled();
  });
});
