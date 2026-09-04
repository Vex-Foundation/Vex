/**
 * mission.setAutoRetry handler tests (phase 4d-5) — host-only auto-retry
 * opt-in. Only the handler is registered for isolation; the engine entry
 * point is a dynamic import, mocked here. Asserts each outcome maps 1:1
 * to the result envelope, input validation gates the engine call, and a
 * thrown engine error becomes a redacted control failure.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockSetMissionAutoRetry = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();

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

vi.mock("@vex-agent/engine/mission/set-auto-retry.js", () => ({
  setMissionAutoRetry: (...a: unknown[]) => mockSetMissionAutoRetry(...a),
}));
vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerMissionSetAutoRetryHandler } = await import(
  "../../mission/set-auto-retry.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const MISSION = "mission-1";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.setAutoRetry);
  if (!handler) throw new Error("No handler for mission.setAutoRetry");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as {
    ok: boolean;
    data?: { outcome: string; [k: string]: unknown };
    error?: { code: string; redacted?: boolean };
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  electronMock.__handlers.clear();
  registerMissionSetAutoRetryHandler();
});

describe("mission.setAutoRetry", () => {
  it("maps `updated` through the envelope", async () => {
    mockSetMissionAutoRetry.mockResolvedValueOnce({
      outcome: "updated",
      enabled: true,
    });
    const r = await call({ sessionId: SESSION, missionId: MISSION, enabled: true });
    expect(r.ok).toBe(true);
    expect(r.data).toEqual({ outcome: "updated", enabled: true });
    expect(mockSetMissionAutoRetry).toHaveBeenCalledWith({
      sessionId: SESSION,
      missionId: MISSION,
      enabled: true,
    });
  });

  it("maps `not_found`", async () => {
    mockSetMissionAutoRetry.mockResolvedValueOnce({ outcome: "not_found" });
    const r = await call({ sessionId: SESSION, missionId: MISSION, enabled: false });
    expect(r.data).toEqual({ outcome: "not_found" });
  });

  it("maps `blocked_permission`", async () => {
    mockSetMissionAutoRetry.mockResolvedValueOnce({
      outcome: "blocked_permission",
    });
    const r = await call({ sessionId: SESSION, missionId: MISSION, enabled: true });
    expect(r.data).toEqual({ outcome: "blocked_permission" });
  });

  it("maps `blocked_status` with the current status", async () => {
    mockSetMissionAutoRetry.mockResolvedValueOnce({
      outcome: "blocked_status",
      status: "running",
    });
    const r = await call({ sessionId: SESSION, missionId: MISSION, enabled: true });
    expect(r.data).toEqual({ outcome: "blocked_status", status: "running" });
  });

  it("rejects invalid input before touching the engine", async () => {
    // `enabled` missing → input schema rejects; engine never called.
    const r = await call({ sessionId: SESSION, missionId: MISSION });
    expect(r.ok).toBe(false);
    expect(mockSetMissionAutoRetry).not.toHaveBeenCalled();
  });

  it("returns a redacted control failure when the engine throws", async () => {
    mockSetMissionAutoRetry.mockRejectedValueOnce(new Error("db down"));
    const r = await call({ sessionId: SESSION, missionId: MISSION, enabled: true });
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain("db down");
  });
});
