/**
 * Mission lineage handler tests — `renew`, `getRenewableSource`.
 *
 * (The rewind/restore transcript-control handlers were removed in
 * phase 4e; this suite is the handler-level coverage for the surviving
 * lineage commands.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import {
  createTestWebContents,
  createTrustedSender,
} from "../test-sender.js";

const mockRenewMission = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockEmitControlStateAfterChange = vi.fn();
const mockGetRenewableSourceForSession = vi.fn();

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

vi.mock("@vex-agent/engine/mission/renew.js", () => ({
  renewMission: (...a: unknown[]) => mockRenewMission(...a),
}));

vi.mock("../../../database/missions-db.js", () => ({
  // `get-draft.ts` uses getDraftForSession; transcript suite doesn't
  // call it, but the import must exist so the module evaluates.
  getDraftForSession: vi.fn().mockResolvedValue({ ok: true, data: null }),
  getRenewableSourceForSession: (...a: unknown[]) =>
    mockGetRenewableSourceForSession(...a),
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

describe("mission.renew", () => {
  it("forwards the `renewed` outcome with new mission id", async () => {
    mockRenewMission.mockResolvedValueOnce({
      outcome: "renewed",
      newMissionId: "mission-2",
      sourceMissionId: MISSION,
    });
    const result = await call(CH.mission.renew, {
      sessionId: SESSION,
      previousMissionId: MISSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      outcome: "renewed",
      newMissionId: "mission-2",
    });
  });

  // WP3 (issue #41): the engine may promote the new draft straight to
  // 'ready' (reconcileDraftReadiness) — the handler emits a control-state
  // refresh so the renderer badge picks it up without a remount.
  it("emits a control-state refresh on a successful renew", async () => {
    mockRenewMission.mockResolvedValueOnce({
      outcome: "renewed",
      newMissionId: "mission-2",
      sourceMissionId: MISSION,
    });
    await call(CH.mission.renew, {
      sessionId: SESSION,
      previousMissionId: MISSION,
    });
    expect(mockEmitControlStateAfterChange).toHaveBeenCalledWith(
      SESSION,
      "11111111-1111-4111-8111-111111111111",
    );
  });

  it("does NOT emit a control-state refresh for a non-renewed outcome", async () => {
    mockRenewMission.mockResolvedValueOnce({
      outcome: "not_accepted",
      sourceMissionId: MISSION,
    });
    const result = await call(CH.mission.renew, {
      sessionId: SESSION,
      previousMissionId: MISSION,
    });
    expect(result.data).toMatchObject({ outcome: "not_accepted" });
    expect(mockEmitControlStateAfterChange).not.toHaveBeenCalled();
  });
});

describe("mission.getRenewableSource", () => {
  it("returns the resolved missionId from the DB helper", async () => {
    mockGetRenewableSourceForSession.mockResolvedValueOnce({
      ok: true,
      data: { missionId: "mission-finished" },
    });
    const result = await call(CH.mission.getRenewableSource, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toEqual({ missionId: "mission-finished" });
    expect(mockGetRenewableSourceForSession).toHaveBeenCalledWith(SESSION);
  });

  it("returns null when no terminal accepted mission exists", async () => {
    mockGetRenewableSourceForSession.mockResolvedValueOnce({
      ok: true,
      data: null,
    });
    const result = await call(CH.mission.getRenewableSource, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(true);
    expect(result.data).toBeNull();
  });

  it("rejects malformed input via schema (non-uuid sessionId)", async () => {
    const result = await call(CH.mission.getRenewableSource, {
      sessionId: "not-a-uuid",
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("validation.invalid_input");
    expect(mockGetRenewableSourceForSession).not.toHaveBeenCalled();
  });

  it("passes a DB error through with the error result shape", async () => {
    mockGetRenewableSourceForSession.mockResolvedValueOnce({
      ok: false,
      error: {
        code: "internal.unexpected",
        domain: "mission",
        message: "Unable to resolve renewable mission source.",
        retryable: true,
        userActionable: false,
        redacted: true,
      },
    });
    const result = await call(CH.mission.getRenewableSource, {
      sessionId: SESSION,
    });
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("internal.unexpected");
  });
});
