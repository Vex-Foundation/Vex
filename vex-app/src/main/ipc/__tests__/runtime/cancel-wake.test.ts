/**
 * runtime.cancelWake tests — the born-dead-end audit-row fix.
 *
 * The wake cancellation itself runs synchronously in the handler; the
 * `runtime_control_requests` row is audit-only. Nothing ever
 * observes/clears a `cancel_wake` row (the checkpoint observer only
 * matches pause_after_step/stop_terminal), so a `'pending'` row is
 * permanently stuck. The kind-agnostic `pending_control_kind` LATERAL
 * (`mission-runs-db.ts`) returns the oldest `status IN ('pending',
 * 'observed')` row for the session — a stranded pending cancel_wake row
 * would disable every mission control button for that session forever.
 * The fix inserts the audit row already `'cleared'`, which the
 * `pending_control_kind` predicate excludes by construction.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockCancelForSession = vi.fn();
const mockEnqueueRequest = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();

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
vi.mock("@vex-agent/db/repos/loop-wake.js", () => ({
  cancelForSession: (...a: unknown[]) => mockCancelForSession(...a),
}));
vi.mock("@vex-agent/db/repos/runtime-control-requests.js", () => ({
  enqueueRequest: (...a: unknown[]) => mockEnqueueRequest(...a),
}));

const { registerRuntimeCancelWakeHandler } = await import(
  "../../runtime/cancel-wake.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000cccc";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.runtime.cancelWake);
  if (!handler) throw new Error("No handler for runtime.cancelWake");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as {
    ok: boolean;
    data?: { outcome: string; cancelledCount?: number };
    error?: { code: string };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  mockEnqueueRequest.mockResolvedValue({
    id: "22222222-2222-4222-8222-222222222222",
  });
  electronMock.__handlers.clear();
  registerRuntimeCancelWakeHandler();
});

describe("runtime.cancelWake", () => {
  it("inserts the audit row already 'cleared' - never a stranded pending row", async () => {
    mockCancelForSession.mockResolvedValueOnce(1);
    const r = await call({ sessionId: SESSION });

    expect(r.data).toEqual({ outcome: "cancelled_wake", cancelledCount: 1 });
    expect(mockEnqueueRequest).toHaveBeenCalledTimes(1);
    expect(mockEnqueueRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION,
        kind: "cancel_wake",
        initialStatus: "cleared",
      }),
    );
  });

  it("still inserts a 'cleared' audit row when there was no pending wake to cancel", async () => {
    mockCancelForSession.mockResolvedValueOnce(0);
    const r = await call({ sessionId: SESSION });

    expect(r.data).toEqual({ outcome: "no_pending_wake" });
    expect(mockEnqueueRequest).toHaveBeenCalledWith(
      expect.objectContaining({ initialStatus: "cleared" }),
    );
  });

  // `pending_control_kind` (mission-runs-db.ts) selects the oldest row with
  // status IN ('pending', 'observed') for the session. Proving the insert
  // call never carries a 'pending'/omitted status is the in-scope way to
  // show that predicate can no longer match a cancel_wake row — the repo
  // itself (runtime-control-requests.test.ts) proves 'cleared' + cleared_at
  // land atomically in the same INSERT.
  it("never enqueues a cancel_wake row with the default 'pending' status", async () => {
    mockCancelForSession.mockResolvedValueOnce(1);
    await call({ sessionId: SESSION });

    const call0 = mockEnqueueRequest.mock.calls[0]?.[0] as { initialStatus?: string };
    expect(call0.initialStatus).toBe("cleared");
    expect(call0.initialStatus).not.toBe("pending");
    expect(call0.initialStatus).not.toBeUndefined();
  });

  it("cancellation still runs even if the audit insert path is reached after it", async () => {
    mockCancelForSession.mockResolvedValueOnce(2);
    await call({ sessionId: SESSION });
    expect(mockCancelForSession).toHaveBeenCalledWith(SESSION, "user_cancel");
    expect(mockEmitControlStateAfterChange).toHaveBeenCalledTimes(1);
  });
});
