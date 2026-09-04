/**
 * mission.edit handler tests — stop the active run so the operator can edit
 * the mission (run terminates, mission → draft). Only the edit handler is
 * registered for isolation; the engine entry point is a dynamic import, mocked.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockStopActiveMissionForEdit = vi.fn();
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

vi.mock("@vex-agent/engine/index.js", () => ({
  stopActiveMissionForEdit: (...a: unknown[]) =>
    mockStopActiveMissionForEdit(...a),
}));
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

const { registerMissionEditHandler } = await import("../../mission/edit.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.edit);
  if (!handler) throw new Error("No handler for mission.edit");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as { ok: boolean; data?: { outcome: string }; error?: { code: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  electronMock.__handlers.clear();
  registerMissionEditHandler();
});

describe("mission.edit", () => {
  it("stops the active run and reports `stopped`", async () => {
    mockStopActiveMissionForEdit.mockResolvedValueOnce({
      stopped: true,
      finalStatus: "draft",
      rejectedApprovals: 0,
    });
    const r = await call({ sessionId: SESSION });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ outcome: "stopped" });
    expect(mockEmitControlStateAfterChange).toHaveBeenCalledTimes(1);
  });

  it("returns no_active_run and does NOT emit control state", async () => {
    mockStopActiveMissionForEdit.mockResolvedValueOnce(null);
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "no_active_run" });
    expect(mockEmitControlStateAfterChange).not.toHaveBeenCalled();
  });

  it("maps the already-terminal race path", async () => {
    mockStopActiveMissionForEdit.mockResolvedValueOnce({
      stopped: false,
      finalStatus: "completed",
      rejectedApprovals: 0,
    });
    const r = await call({ sessionId: SESSION });
    expect(r.data).toEqual({ outcome: "already_terminal" });
    expect(mockEmitControlStateAfterChange).toHaveBeenCalledTimes(1);
  });
});
