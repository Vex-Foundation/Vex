/**
 * mission.retry handler / runRetryDispatch tests.
 *
 * Recover-after-error claims + resumes ONLY a `paused_error` run; every other
 * state is classified explicitly (so the dispatcher is total). Only the retry
 * handler is registered for isolation; the engine claim/resume modules are
 * dynamic imports, mocked here.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockGetLatestRunForSession = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();
const mockEnqueueRequest = vi.fn();
const mockMarkObserved = vi.fn();
const mockMarkCleared = vi.fn();
const mockMarkFailed = vi.fn();
const mockClaim = vi.fn();
const mockCreateLeaseHandle = vi.fn();
const mockResumeMissionRun = vi.fn();
const mockRelease = vi.fn();

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
    getLatestRunForSession: (...a: unknown[]) =>
      mockGetLatestRunForSession(...a),
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
vi.mock("@vex-agent/db/repos/runtime-control-requests.js", () => ({
  enqueueRequest: (...a: unknown[]) => mockEnqueueRequest(...a),
  markObserved: (...a: unknown[]) => mockMarkObserved(...a),
  markCleared: (...a: unknown[]) => mockMarkCleared(...a),
  markFailed: (...a: unknown[]) => mockMarkFailed(...a),
}));
// Phase 4d: runRetryDispatch cancels pending error_retry wakes before claiming.
const mockCancelForSession = vi.fn().mockResolvedValue(0);
vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: (...a: unknown[]) => mockCancelForSession(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-and-status.js", () => ({
  claimRunLeaseAndFlipToRunning: (...a: unknown[]) => mockClaim(...a),
}));
vi.mock("@vex-agent/engine/runtime/lease-handle.js", () => ({
  createLeaseHandle: (...a: unknown[]) => mockCreateLeaseHandle(...a),
}));
vi.mock("@vex-agent/engine/index.js", () => ({
  resumeMissionRun: (...a: unknown[]) => mockResumeMissionRun(...a),
}));
vi.mock("@vex-agent/engine/runtime/release-and-emit.js", () => ({
  releaseLeaseAndEmitControlState: (...a: unknown[]) => mockRelease(...a),
}));

const { registerMissionRetryHandler } = await import("../../mission/retry.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.retry);
  if (!handler) throw new Error("No handler for mission.retry");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as {
    ok: boolean;
    data?: { outcome: string; [k: string]: unknown };
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  electronMock.__handlers.clear();
  registerMissionRetryHandler();
});

describe("mission.retry", () => {
  it("returns no_active_run when the session never had a run", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({ ok: true, data: null });
    const r = await call({ sessionId: SESSION });
    expect(r.ok).toBe(true);
    expect(r.data?.outcome).toBe("no_active_run");
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("returns already_running for a running run with a LIVE lease", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "running", leaseActive: true },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "already_running", runId: "run-1" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("attempts to RECLAIM (fromStatuses=['running']) instead of already_running when the lease is DEAD", async () => {
    // Regression: status='running' alone does not mean a runner is
    // observing the session (issue #12's bug class, ported to retry too).
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-dead", status: "running", leaseActive: false },
    });
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-dead" });
    mockClaim.mockResolvedValueOnce({
      outcome: "claimed",
      lease: { ownerId: "owner-y" },
      previousStatus: "running",
      wakeCancelledCount: 0,
    });
    mockCreateLeaseHandle.mockReturnValueOnce({});
    mockResumeMissionRun.mockResolvedValueOnce({ text: "ok" });
    mockRelease.mockResolvedValue(undefined);

    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "resumed", runId: "run-dead" });
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatuses: ["running"],
        missionRunId: "run-dead",
      }),
    );
    // A running row never has an error_retry wake pending — the
    // paused_error-only wake cancellation must not fire here.
    expect(mockCancelForSession).not.toHaveBeenCalled();
    await vi.waitFor(() =>
      expect(mockResumeMissionRun).toHaveBeenCalledWith("run-dead", "owner-y"),
    );
  });

  it("returns blocked_approval for a paused_approval run", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "paused_approval" },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({
      outcome: "blocked_approval",
      pendingApprovalId: "run-1",
    });
  });

  it("returns blocked_terminal for a terminal run", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "failed" },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "blocked_terminal", status: "failed" });
  });

  it("returns not_recoverable for a paused_wake run (use Continue)", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-1", status: "paused_wake" },
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "not_recoverable", status: "paused_wake" });
    expect(mockClaim).not.toHaveBeenCalled();
  });

  it("claims (fromStatuses paused_error) + resumes a paused_error run", async () => {
    mockGetLatestRunForSession.mockResolvedValue({
      ok: true,
      data: { missionRunId: "run-err", status: "paused_error" },
    });
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-1" });
    mockClaim.mockResolvedValueOnce({
      outcome: "claimed",
      lease: { ownerId: "owner-x" },
      previousStatus: "paused_error",
    });
    mockCreateLeaseHandle.mockReturnValueOnce({});
    mockResumeMissionRun.mockResolvedValueOnce({ text: "ok" });
    mockRelease.mockResolvedValue(undefined);

    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "resumed", runId: "run-err" });
    expect(mockClaim).toHaveBeenCalledWith(
      expect.objectContaining({
        fromStatuses: ["paused_error"],
        missionRunId: "run-err",
      }),
    );
    // Fire-and-forget continuation (dynamic-imports the engine) — poll for it.
    await vi.waitFor(() =>
      expect(mockResumeMissionRun).toHaveBeenCalledWith("run-err", "owner-x"),
    );
  });

  it("maps lease_busy with a retryAfterMs hint and never leaks the owner id", async () => {
    mockGetLatestRunForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionRunId: "run-err", status: "paused_error" },
    });
    mockEnqueueRequest.mockResolvedValueOnce({ id: "audit-1" });
    mockClaim.mockResolvedValueOnce({
      outcome: "lease_busy",
      currentLease: {
        ownerId: "secret-owner",
        expiresAt: new Date(Date.now() + 30_000),
      },
    });

    const r = await call({ sessionId: SESSION });
    expect(r.data?.outcome).toBe("lease_busy");
    expect(JSON.stringify(r.data)).not.toContain("secret-owner");
    expect(mockResumeMissionRun).not.toHaveBeenCalled();
  });
});
