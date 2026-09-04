/**
 * sessions.planSetEnabled handler (Codex holistic-review blockers).
 *
 * Turning plan-mode OFF must not strand a mission run. For an ACTIVE run the
 * handler routes through `disableSessionPlanForActiveRun`, whose repo UPDATE
 * atomically refuses (blocked_pending_acceptance) when an enabled, non-empty,
 * UNACCEPTED plan exists — race-safe vs a concurrent `plan_write` in either
 * ordering. Reads fail closed. Enabling / no-active-run use the plain path.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockSetEnabled = vi.fn();
const mockDisableForRun = vi.fn();
const mockGetActiveRun = vi.fn();
const mockEnsureDbUrl = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, p: unknown) => unknown) =>
        handlers.set(channel, fn)),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});

vi.mock("@vex-agent/engine/plan/authority.js", () => ({
  setSessionPlanEnabled: (...a: unknown[]) => mockSetEnabled(...a),
  disableSessionPlanForActiveRun: (...a: unknown[]) => mockDisableForRun(...a),
  acceptSessionPlan: vi.fn(),
  getSessionPlan: vi.fn(),
}));
vi.mock("../../../database/mission-runs-db.js", () => ({
  getActiveRunForSession: (...a: unknown[]) => mockGetActiveRun(...a),
}));
vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureDbUrl(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerSessionPlanHandlers } = await import("../../sessions/plan.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
// updatedAt MUST be an ISO datetime with offset — planStateSchema validates it
// via z.string().datetime({ offset: true }) and the handler output is schema-
// checked, so a placeholder like "t" makes the happy-path output fail validation.
const PLAN = {
  enabled: true,
  planMd: "# plan",
  accepted: false,
  acceptedAt: null,
  updatedAt: "2026-06-20T07:00:00.000Z",
};
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function callSetEnabled(enabled: boolean) {
  const handler = electronMock.__handlers.get(CH.sessions.planSetEnabled);
  if (!handler) throw new Error("No handler for sessions.planSetEnabled");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload: { sessionId: SESSION, enabled },
  })) as { ok: boolean; data?: { outcome: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockSetEnabled.mockResolvedValue({ outcome: "ok", plan: { ...PLAN, enabled: false } });
  mockDisableForRun.mockResolvedValue({ outcome: "ok", plan: { ...PLAN, enabled: false } });
  electronMock.__handlers.clear();
  registerSessionPlanHandlers();
});

describe("sessions.planSetEnabled", () => {
  it("REFUSES disabling for an active run when the atomic guard reports pending acceptance", async () => {
    mockGetActiveRun.mockResolvedValue({
      ok: true,
      data: { hasActiveRun: true, missionRunId: "run-1", status: "running" },
    });
    mockDisableForRun.mockResolvedValue({ outcome: "blocked_pending_acceptance" });
    const res = await callSetEnabled(false);
    expect(res.ok).toBe(true);
    expect(res.data?.outcome).toBe("blocked_pending_acceptance");
    // Routed through the ATOMIC guarded disable, never the plain setter.
    expect(mockDisableForRun).toHaveBeenCalledWith(SESSION);
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("disables for an active run when the atomic guard allows (accepted / no pending plan)", async () => {
    mockGetActiveRun.mockResolvedValue({
      ok: true,
      data: { hasActiveRun: true, missionRunId: "run-1", status: "running" },
    });
    mockDisableForRun.mockResolvedValue({ outcome: "ok", plan: { ...PLAN, enabled: false, accepted: true } });
    const res = await callSetEnabled(false);
    expect(res.ok).toBe(true);
    expect(res.data?.outcome).toBe("updated");
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("fails closed (does NOT disable) when the run state cannot be read", async () => {
    mockGetActiveRun.mockResolvedValue({ ok: false, error: { code: "db_unavailable" } });
    const res = await callSetEnabled(false);
    expect(res.ok).toBe(false);
    expect(mockDisableForRun).not.toHaveBeenCalled();
    expect(mockSetEnabled).not.toHaveBeenCalled();
  });

  it("uses the plain setter when disabling with no active run", async () => {
    mockGetActiveRun.mockResolvedValue({ ok: true, data: { hasActiveRun: false, missionRunId: null, status: null } });
    const res = await callSetEnabled(false);
    expect(res.ok).toBe(true);
    expect(res.data?.outcome).toBe("updated");
    expect(mockDisableForRun).not.toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenCalledWith(SESSION, false);
  });

  it("allows enabling without consulting the run gate", async () => {
    const res = await callSetEnabled(true);
    expect(res.ok).toBe(true);
    expect(res.data?.outcome).toBe("updated");
    expect(mockGetActiveRun).not.toHaveBeenCalled();
    expect(mockSetEnabled).toHaveBeenCalledWith(SESSION, true);
  });
});
