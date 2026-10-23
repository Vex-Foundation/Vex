/**
 * `mission.setModel` handler (F06): the schema gates the shape, main checks a
 * model against the ACTIVE backend's catalogue before the engine is called,
 * the engine outcome is returned as is, and a thrown engine error is
 * redacted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "../test-sender.js";

const mockSetMissionModel = vi.fn();
const mockEnsureEngineDbUrl = vi.fn();
const mockLoadCatalog = vi.fn();

type Handler = (e: unknown, p: unknown) => unknown;

const handlers = vi.hoisted(() => new Map<string, (e: unknown, p: unknown) => unknown>());

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (e: unknown, p: unknown) => unknown) => handlers.set(channel, fn)),
    removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
  },
}));

vi.mock("@vex-agent/engine/mission/set-model.js", () => ({
  setMissionModel: (...a: unknown[]) => mockSetMissionModel(...a),
}));
vi.mock("../../../database/engine-db-readiness.js", () => ({
  ensureEngineDbUrl: (...a: unknown[]) => mockEnsureEngineDbUrl(...a),
}));
vi.mock("../../../onboarding/provider-model-catalog.js", () => ({
  loadProviderModelCatalog: (...a: unknown[]) => mockLoadCatalog(...a),
}));
vi.mock("../../../logger/index.js", () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { registerMissionSetModelHandler } = await import("../../mission/set-model.js");

const SESSION = "00000000-0000-4000-8000-00000000bbbb";
const MISSION = "mission-1";
const SONNET = { provider: "vexcloud", modelId: "anthropic/claude-sonnet-5.5" } as const;
const trustedSender = createTrustedSender({ sender: createTestWebContents() });
const previousProvider = process.env.AGENT_PROVIDER;

async function call(payload: unknown): Promise<unknown> {
  const handler: Handler | undefined = handlers.get(CH.mission.setModel);
  if (!handler) throw new Error("No handler for mission.setModel");
  return handler(trustedSender, { requestId: "11111111-1111-4111-8111-111111111111", payload });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.AGENT_PROVIDER = "vexcloud";
  mockEnsureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mockLoadCatalog.mockResolvedValue({
    models: [{ modelId: SONNET.modelId, displayName: "Sonnet", providerId: "anthropic", contextLength: 1_000_000, pricingInputPerMillion: "3", pricingOutputPerMillion: "15" }],
  });
  handlers.clear();
  registerMissionSetModelHandler();
});

afterEach(() => {
  if (previousProvider === undefined) delete process.env.AGENT_PROVIDER;
  else process.env.AGENT_PROVIDER = previousProvider;
});

describe("mission.setModel", () => {
  it("passes a listed model to the engine and returns its outcome", async () => {
    mockSetMissionModel.mockResolvedValueOnce({ outcome: "updated", model: SONNET, acceptanceCleared: true });
    const r = await call({ sessionId: SESSION, missionId: MISSION, model: SONNET });
    expect(mockLoadCatalog).toHaveBeenCalledWith(expect.objectContaining({ source: "vexcloud" }));
    expect(mockSetMissionModel).toHaveBeenCalledWith({ sessionId: SESSION, missionId: MISSION, model: SONNET });
    expect(r).toMatchObject({ ok: true, data: { outcome: "updated", acceptanceCleared: true } });
  });

  it("passes a clear as null without a catalogue read", async () => {
    mockSetMissionModel.mockResolvedValueOnce({ outcome: "updated", model: null, acceptanceCleared: false });
    await call({ sessionId: SESSION, missionId: MISSION, model: null });
    expect(mockLoadCatalog).not.toHaveBeenCalled();
    expect(mockSetMissionModel).toHaveBeenCalledWith(expect.objectContaining({ model: null }));
  });

  it("refuses a model the active backend does not list, before the engine", async () => {
    const r = await call({ sessionId: SESSION, missionId: MISSION, model: { ...SONNET, modelId: "vendor/not-listed" } });
    expect(r).toMatchObject({ ok: false, error: { code: "validation.invalid_input", domain: "mission" } });
    expect(mockSetMissionModel).not.toHaveBeenCalled();
  });

  it("refuses a model picked for the other backend", async () => {
    const r = await call({ sessionId: SESSION, missionId: MISSION, model: { ...SONNET, provider: "openrouter" } });
    expect(r).toMatchObject({ ok: false });
    expect(mockSetMissionModel).not.toHaveBeenCalled();
  });

  it("refuses a malformed model at the schema", async () => {
    const r = await call({ sessionId: SESSION, missionId: MISSION, model: { provider: "vexcloud", modelId: "-bad id" } });
    expect(r).toMatchObject({ ok: false });
    expect(mockSetMissionModel).not.toHaveBeenCalled();
  });

  it("redacts a thrown engine error", async () => {
    mockSetMissionModel.mockRejectedValueOnce(new Error("db exploded at host x"));
    const r = await call({ sessionId: SESSION, missionId: MISSION, model: SONNET });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toContain("db exploded");
  });
});
