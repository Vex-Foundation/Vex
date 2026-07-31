/**
 * `runtime.getState` → `pausedWake` composition.
 *
 * The wake read is COMPOSED at the handler, not folded into
 * `getActiveRunForSession`'s query, for two reasons: the run query already
 * joins three tables and owns the control-gating contract, and the wake row
 * belongs to `wake-db.ts`. That composition has to satisfy three properties:
 *
 *  1. only a `paused_wake` run pays for the extra round-trip — every other
 *     status must not touch the wake table at all;
 *  2. `pausedWake` is ABSENT (not null) when there is nothing to show, so the
 *     additive field stays invisible to existing consumers and the renderer's
 *     gate is a single presence check;
 *  3. a failed/empty wake read still yields a successful runtime state. The
 *     banner is a decoration; the pause/stop/resume gating is not.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockGetActiveRunForSession = vi.fn();
const mockGetPendingWakeForSession = vi.fn();

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

vi.mock("../../../database/mission-runs-db.js", () => ({
  getActiveRunForSession: (...a: unknown[]) => mockGetActiveRunForSession(...a),
}));
vi.mock("../../../database/wake-db.js", () => ({
  getPendingWakeForSession: (...a: unknown[]) =>
    mockGetPendingWakeForSession(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerRuntimeGetStateHandler } = await import(
  "../../runtime/get-state.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000dddd";
const DUE = "2026-07-30T20:57:00.000Z";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

function runState(status: string) {
  return {
    sessionId: SESSION,
    hasActiveRun: true,
    missionRunId: "run-1",
    status,
    stopReason: null,
    lastCheckpointAt: null,
    startedAt: "2026-07-30T20:00:00.000Z",
    iterationCount: 2,
    leaseActive: false,
    leaseExpiresAt: null,
    pendingControlKind: null,
  };
}

async function call() {
  const handler = electronMock.__handlers.get(CH.runtime.getState);
  if (!handler) throw new Error("No handler for runtime.getState");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { sessionId: SESSION },
  })) as {
    ok: boolean;
    data?: Record<string, unknown>;
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.__handlers.clear();
  registerRuntimeGetStateHandler();
});

describe("runtime.getState pausedWake", () => {
  it("attaches pausedWake for a paused_wake run", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: true,
      data: runState("paused_wake"),
    });
    mockGetPendingWakeForSession.mockResolvedValueOnce({
      dueAt: DUE,
      reason: "waiting for the funding window",
      watchSummary: "price",
    });

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data?.pausedWake).toEqual({
      dueAt: DUE,
      reason: "waiting for the funding window",
      watchSummary: "price",
    });
    expect(mockGetPendingWakeForSession).toHaveBeenCalledWith(SESSION);
  });

  it.each(["running", "paused_approval", "paused_error", "paused_user"])(
    "never reads the wake table and omits pausedWake for status %s",
    async (status) => {
      mockGetActiveRunForSession.mockResolvedValueOnce({
        ok: true,
        data: runState(status),
      });

      const r = await call();

      expect(r.ok).toBe(true);
      expect(r.data && "pausedWake" in r.data).toBe(false);
      expect(mockGetPendingWakeForSession).not.toHaveBeenCalled();
    },
  );

  it("omits pausedWake when the run is paused_wake but no pending row remains", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: true,
      data: runState("paused_wake"),
    });
    // Real transient: the executor claimed the row (pending → consumed) between
    // the run read and this one. "Not sleeping" is the honest answer.
    mockGetPendingWakeForSession.mockResolvedValueOnce(null);

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data && "pausedWake" in r.data).toBe(false);
  });

  it("still returns a successful runtime state when the wake read throws", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: true,
      data: runState("paused_wake"),
    });
    mockGetPendingWakeForSession.mockRejectedValueOnce(new Error("db down"));

    const r = await call();

    expect(r.ok).toBe(true);
    expect(r.data?.status).toBe("paused_wake");
    expect(r.data && "pausedWake" in r.data).toBe(false);
  });

  it("does not read the wake table when the run query itself failed", async () => {
    mockGetActiveRunForSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "runtime",
        message: "Unable to load runtime state.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });

    const r = await call();

    expect(r.ok).toBe(false);
    expect(mockGetPendingWakeForSession).not.toHaveBeenCalled();
  });
});
