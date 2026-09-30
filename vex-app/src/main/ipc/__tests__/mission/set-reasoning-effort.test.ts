/**
 * `mission.setReasoningEffort` handler (Kairos E-1): the schema gates the
 * engine call (only a known effort or null passes), the engine outcome is
 * returned as is, and a thrown engine error is redacted.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockSetMissionReasoningEffort = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();

type Handler = (e: unknown, p: unknown) => unknown;

const handlers = vi.hoisted(() => new Map<string, (e: unknown, p: unknown) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (e: unknown, p: unknown) => unknown) => handlers.set(channel, fn)),
    removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
  },
}));

vi.mock("@vex-agent/engine/mission/set-reasoning-effort.js", () => ({
  setMissionReasoningEffort: (...a: unknown[]) => mockSetMissionReasoningEffort(...a),
}));
vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerMissionSetReasoningEffortHandler } = await import(
  "../../mission/set-reasoning-effort.js"
);

const SESSION = "00000000-0000-4000-8000-00000000bbbb";
const MISSION = "mission-1";
const trustedSender = createTrustedSender({ sender: createTestWebContents() });

async function call(payload: unknown): Promise<unknown> {
  const handler: Handler | undefined = handlers.get(CH.mission.setReasoningEffort);
  if (!handler) throw new Error("No handler for mission.setReasoningEffort");
  return handler(trustedSender, { requestId: "11111111-1111-4111-8111-111111111111", payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  handlers.clear();
  registerMissionSetReasoningEffortHandler();
});

describe("mission.setReasoningEffort", () => {
  it("passes a known effort to the engine and returns its outcome", async () => {
    mockSetMissionReasoningEffort.mockResolvedValueOnce({
      outcome: "updated",
      reasoningEffort: "low",
      acceptanceCleared: true,
    });
    const r = await call({ sessionId: SESSION, missionId: MISSION, reasoningEffort: "low" });
    expect(mockSetMissionReasoningEffort).toHaveBeenCalledWith({
      sessionId: SESSION,
      missionId: MISSION,
      reasoningEffort: "low",
    });
    expect(r).toMatchObject({ ok: true, data: { outcome: "updated", acceptanceCleared: true } });
  });

  it("passes a clear as null", async () => {
    mockSetMissionReasoningEffort.mockResolvedValueOnce({
      outcome: "updated",
      reasoningEffort: null,
      acceptanceCleared: false,
    });
    await call({ sessionId: SESSION, missionId: MISSION, reasoningEffort: null });
    expect(mockSetMissionReasoningEffort).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: null }),
    );
  });

  it("refuses an unknown effort before the engine is called", async () => {
    const r = await call({ sessionId: SESSION, missionId: MISSION, reasoningEffort: "turbo" });
    expect(r).toMatchObject({ ok: false });
    expect(mockSetMissionReasoningEffort).not.toHaveBeenCalled();
  });

  it("redacts a thrown engine error", async () => {
    mockSetMissionReasoningEffort.mockRejectedValueOnce(new Error("db exploded at host x"));
    const r = await call({ sessionId: SESSION, missionId: MISSION, reasoningEffort: "high" });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("db exploded");
  });
});
