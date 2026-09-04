/**
 * Mission contract-surface handler tests (puzzle 04 phase 6) —
 * `acceptContract`, `getDiff`, `updateDraft`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockAcceptContract = vi.fn();
const mockGetContractStatus = vi.fn();
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

vi.mock("@vex-agent/engine/mission/acceptance.js", () => ({
  acceptContract: (...a: unknown[]) => mockAcceptContract(...a),
}));

vi.mock("@vex-agent/engine/mission/diff.js", () => ({
  getContractStatus: (...a: unknown[]) => mockGetContractStatus(...a),
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

describe("mission.acceptContract", () => {
  it("forwards engine `accepted` outcome to the renderer", async () => {
    mockAcceptContract.mockResolvedValueOnce({
      outcome: "accepted",
      missionId: MISSION,
      acceptedContractHash: "a".repeat(64),
      acceptedAt: "2026-05-22T10:00:00.000Z",
      acceptedBy: "host",
      contractHashVersion: 1,
    });
    const result = await call(CH.mission.acceptContract, {
      sessionId: SESSION,
      missionId: MISSION,
      contractHash: "a".repeat(64),
    });
    expect(result.ok).toBe(true);
    expect((result.data as { outcome: string }).outcome).toBe("accepted");
    expect(mockAcceptContract).toHaveBeenCalledWith({
      sessionId: SESSION,
      missionId: MISSION,
      contractHash: "a".repeat(64),
    });
  });

  it("forwards `hash_mismatch` outcome", async () => {
    mockAcceptContract.mockResolvedValueOnce({
      outcome: "hash_mismatch",
      providedHash: "a".repeat(64),
      currentHash: "b".repeat(64),
    });
    const result = await call(CH.mission.acceptContract, {
      sessionId: SESSION,
      missionId: MISSION,
      contractHash: "a".repeat(64),
    });
    expect(result.ok).toBe(true);
    expect((result.data as { outcome: string }).outcome).toBe("hash_mismatch");
  });
});

describe("mission.getDiff", () => {
  it("returns the full contract status payload", async () => {
    mockGetContractStatus.mockResolvedValueOnce({
      outcome: "ready",
      missionId: MISSION,
      sessionId: SESSION,
      currentHash: "a".repeat(64),
      contractHashVersion: 1,
      acceptedHash: null,
      acceptedAt: null,
      acceptedBy: null,
      acceptedContractHashVersion: null,
      isAccepted: false,
      isDirty: false,
    });
    const result = await call(CH.mission.getDiff, {
      sessionId: SESSION,
      missionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect((result.data as { outcome: string }).outcome).toBe("ready");
  });
});

describe("mission.updateDraft", () => {
  it("returns ok+`unavailable` while draft mutation remains fail-closed", async () => {
    const result = await call(CH.mission.updateDraft, { sessionId: SESSION });
    expect(result.ok).toBe(true);
    expect((result.data as { outcome: string }).outcome).toBe("unavailable");
  });
});
