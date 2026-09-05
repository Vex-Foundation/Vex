/**
 * Mission run-lifecycle handler tests (puzzle 04 phase 6) —
 * `start` and `recover`. Both wrap a synchronous durable prepare
 * step + fire-and-forget background continuation.
 *
 * Codex-required cases:
 *   - cross-session `start` reject (no continuation call)
 *   - `start` maps `not_ready` with missingFields
 *   - `start` `lease_busy` strips ownerId
 *   - `recover` `no_failed_run` (no continuation call)
 *   - `recover` `session_has_active_run` (no continuation call)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockPrepareMissionStart = vi.fn();
const mockRunPreparedMissionStart = vi.fn();
const mockPrepareMissionRecover = vi.fn();
const mockRunPreparedMissionRecover = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>();
  return {
    ipcMain: {
      handle: vi.fn(
        (
          channel: string,
          fn: (e: IpcMainInvokeEvent, p: unknown) => unknown,
        ) => handlers.set(channel, fn),
      ),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    __handlers: handlers,
  };
});

vi.mock("@vex-agent/engine/core/runner/mission.js", () => ({
  prepareMissionStart: (...a: unknown[]) => mockPrepareMissionStart(...a),
  runPreparedMissionStart: (...a: unknown[]) =>
    mockRunPreparedMissionStart(...a),
}));

vi.mock("@vex-agent/engine/core/runner/recover.js", () => ({
  prepareMissionRecover: (...a: unknown[]) => mockPrepareMissionRecover(...a),
  runPreparedMissionRecover: (...a: unknown[]) =>
    mockRunPreparedMissionRecover(...a),
}));

vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));

vi.mock("../../runtime/_emit-control-state.js", () => ({
  emitControlStateAfterChange: (...a: unknown[]) =>
    mockEmitControlStateAfterChange(...a),
}));

vi.mock("../../../logger/index.js", () => ({
  log: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const { registerMissionHandlers } = await import("../../mission.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const MISSION = "mission-1";

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(channel: string, payload: unknown) {
  const handler = electronMock.__handlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return (await handler(
    trustedSender as unknown as IpcMainInvokeEvent,
    {
      requestId: "11111111-1111-4111-8111-111111111111",
      payload,
    },
  )) as { ok: boolean; data?: unknown; error?: { code: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  electronMock.__handlers.clear();
  registerMissionHandlers();
});

describe("mission.start", () => {
  it("rejects cross-session WITHOUT invoking the run continuation", async () => {
    mockPrepareMissionStart.mockResolvedValueOnce({
      outcome: "session_mismatch",
      expectedSessionId: "11111111-1111-4111-8111-11111111dead",
    });
    const result = await call(CH.mission.start, {
      sessionId: SESSION,
      missionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { outcome: string }).outcome).toBe(
      "session_mismatch",
    );
    expect(mockRunPreparedMissionStart).not.toHaveBeenCalled();
  });

  it("maps `not_ready` with missingFields array", async () => {
    mockPrepareMissionStart.mockResolvedValueOnce({
      outcome: "not_ready",
      missingFields: ["goal", "successCriteria"],
    });
    const result = await call(CH.mission.start, {
      sessionId: SESSION,
      missionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      outcome: "not_ready",
      missingFields: ["goal", "successCriteria"],
    });
    expect(mockRunPreparedMissionStart).not.toHaveBeenCalled();
  });

  it("forwards `plan_not_accepted` (Stage 6 start-gate) WITHOUT dispatching the run", async () => {
    mockPrepareMissionStart.mockResolvedValueOnce({
      outcome: "plan_not_accepted",
      missionId: MISSION,
    });
    const result = await call(CH.mission.start, {
      sessionId: SESSION,
      missionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      outcome: "plan_not_accepted",
      missionId: MISSION,
    });
    // Fail closed: the run continuation must NOT fire when the plan gate trips.
    expect(mockRunPreparedMissionStart).not.toHaveBeenCalled();
  });

  it("returns `dispatched` with missionRunId after prepared", async () => {
    mockPrepareMissionStart.mockResolvedValueOnce({
      outcome: "prepared",
      prepared: {
        runId: "run-abc",
        missionId: MISSION,
        sessionId: SESSION,
      },
    });
    mockRunPreparedMissionStart.mockResolvedValueOnce({
      text: "ok",
      toolCallsMade: 0,
      pendingApprovals: [],
      stopReason: null,
      missionStatus: "running",
    });
    const result = await call(CH.mission.start, {
      sessionId: SESSION,
      missionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      outcome: "dispatched",
      missionRunId: "run-abc",
      sessionId: SESSION,
    });
  });

  it("strips lease ownerId from `lease_busy` outcome", async () => {
    const expires = new Date(Date.now() + 30_000);
    mockPrepareMissionStart.mockResolvedValueOnce({
      outcome: "lease_busy",
      currentLease: {
        sessionId: SESSION,
        missionRunId: null,
        ownerId: "secret-owner-id",
        processKind: "electron_main",
        acquiredAt: new Date(),
        heartbeatAt: new Date(),
        expiresAt: expires,
      },
    });
    const result = await call(CH.mission.start, {
      sessionId: SESSION,
      missionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result.data)).not.toContain("secret-owner-id");
  });
});

describe("mission.recover", () => {
  it("returns `no_failed_run` when no terminal failed mission run exists", async () => {
    mockPrepareMissionRecover.mockResolvedValueOnce({
      outcome: "no_failed_run",
    });
    const result = await call(CH.mission.recover, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { outcome: string }).outcome).toBe("no_failed_run");
    expect(mockRunPreparedMissionRecover).not.toHaveBeenCalled();
  });

  it("returns `session_has_active_run` when an active run exists", async () => {
    mockPrepareMissionRecover.mockResolvedValueOnce({
      outcome: "session_has_active_run",
      missionRunId: "run-active",
      runStatus: "running",
    });
    const result = await call(CH.mission.recover, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "session_has_active_run",
      missionRunId: "run-active",
    });
    expect(mockRunPreparedMissionRecover).not.toHaveBeenCalled();
  });

  it("returns `dispatched` with newRunId after prepared", async () => {
    mockPrepareMissionRecover.mockResolvedValueOnce({
      outcome: "prepared",
      prepared: {
        newRunId: "run-recovered",
        recoveredFromRunId: "run-failed",
        missionId: MISSION,
        sessionId: SESSION,
      },
    });
    mockRunPreparedMissionRecover.mockResolvedValueOnce({
      text: "recovered",
    });
    const result = await call(CH.mission.recover, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      outcome: "dispatched",
      missionRunId: "run-recovered",
      recoveredFromRunId: "run-failed",
    });
  });
});
