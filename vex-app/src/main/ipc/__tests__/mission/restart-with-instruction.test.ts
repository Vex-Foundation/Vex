/**
 * `mission.restartWithInstruction` handler.
 *
 * The properties worth pinning are the refusal ones. A drifted contract must
 * NOT start a run — restarting against a contract the user never accepted is a
 * consent bypass, and the whole affordance exists one click away from a
 * mission that moves real funds. The schema bound on the instruction is the
 * second: this text becomes a transcript row the agent re-reads every turn, so
 * an over-long or empty one is rejected at the boundary rather than trimmed
 * into something the user did not type.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { MISSION_RESTART_INSTRUCTION_MAX_LENGTH } from "@shared/schemas/mission.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockRestartMissionWithInstruction = vi.fn();
const mockRunPreparedMissionStart = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();

vi.mock("electron", () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>();
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

vi.mock("@vex-agent/engine/mission/restart-with-instruction.js", () => ({
  restartMissionWithInstruction: (...a: unknown[]) =>
    mockRestartMissionWithInstruction(...a),
}));

vi.mock("@vex-agent/engine/core/runner/mission.js", () => ({
  prepareMissionStart: vi.fn(),
  runPreparedMissionStart: (...a: unknown[]) => mockRunPreparedMissionStart(...a),
}));

vi.mock("@vex-agent/engine/core/runner/recover.js", () => ({
  prepareMissionRecover: vi.fn(),
  runPreparedMissionRecover: vi.fn(),
}));

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

const { registerMissionHandlers } = await import("../../mission.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const SESSION = "00000000-0000-4000-8000-00000000aaaa";
const MISSION = "00000000-0000-4000-8000-00000000bbbb";
const RUN = "00000000-0000-4000-8000-00000000cccc";

const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown) {
  const handler = electronMock.__handlers.get(CH.mission.restartWithInstruction);
  if (!handler) throw new Error("No handler for restartWithInstruction");
  return (await handler(trustedSender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  })) as { ok: boolean; data?: unknown; error?: { code: string } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockEmitControlStateAfterChange.mockResolvedValue(undefined);
  electronMock.__handlers.clear();
  registerMissionHandlers();
});

describe("mission.restartWithInstruction", () => {
  it("dispatches the prepared run in the background and returns its id", async () => {
    mockRestartMissionWithInstruction.mockResolvedValueOnce({
      outcome: "prepared",
      prepared: { runId: RUN, missionId: MISSION, sessionId: SESSION },
    });

    const result = await call({
      sessionId: SESSION,
      missionId: MISSION,
      instruction: "Skip the SOL leg this time.",
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      outcome: "dispatched",
      missionRunId: RUN,
      sessionId: SESSION,
    });
    expect(mockRunPreparedMissionStart).toHaveBeenCalledTimes(1);
    expect(mockEmitControlStateAfterChange).toHaveBeenCalledWith(
      SESSION,
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("refuses a drifted contract and starts NOTHING", async () => {
    mockRestartMissionWithInstruction.mockResolvedValueOnce({
      outcome: "contract_dirty",
      reason: "stale_acceptance",
    });

    const result = await call({
      sessionId: SESSION,
      missionId: MISSION,
      instruction: "Do it differently.",
    });

    expect(result.ok).toBe(true);
    expect(result.data).toEqual({
      outcome: "contract_dirty",
      reason: "stale_acceptance",
    });
    expect(mockRunPreparedMissionStart).not.toHaveBeenCalled();
  });

  it("rejects an over-long instruction at the schema boundary", async () => {
    const result = await call({
      sessionId: SESSION,
      missionId: MISSION,
      instruction: "x".repeat(MISSION_RESTART_INSTRUCTION_MAX_LENGTH + 1),
    });

    expect(result.ok).toBe(false);
    expect(mockRestartMissionWithInstruction).not.toHaveBeenCalled();
  });

  it("rejects an empty instruction at the schema boundary", async () => {
    const result = await call({
      sessionId: SESSION,
      missionId: MISSION,
      instruction: "",
    });

    expect(result.ok).toBe(false);
    expect(mockRestartMissionWithInstruction).not.toHaveBeenCalled();
  });
});
