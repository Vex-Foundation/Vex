/**
 * vex.chat.steer IPC handler.
 *
 * Contract under test: strict boundary validation (uuid session, 1-2000
 * char message, no extra fields such as reasoningEffort); the engine's
 * `queued_live` / `no_active_turn` outcome passes through untouched; an
 * unknown session fails by name BEFORE the engine is reached; an engine
 * throw surfaces through the classified engine-error copy, and the handler
 * never retries (queued_live wrote a transcript row).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "./test-sender.js";

const mocks = vi.hoisted(() => ({
  submitSteeringMessage: vi.fn(),
  getSessionById: vi.fn(),
  ensureEngineDbUrl: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

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
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
vi.mock("../../database/sessions-db.js", () => ({
  getSessionById: mocks.getSessionById,
}));
vi.mock("../chat/engine-db-url.js", () => ({
  ensureEngineDbUrl: mocks.ensureEngineDbUrl,
}));
vi.mock("@vex-agent/engine/index.js", () => ({
  submitSteeringMessage: mocks.submitSteeringMessage,
}));

const { registerChatSteerHandler } = await import("../chat-steer.js");
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const sender = createTrustedSender({ sender: createTestWebContents() });
const SESSION_ID = "00000000-0000-4000-8000-000000000001";

async function invoke(payload: unknown): Promise<any> {
  const handler = electronMock.__handlers.get(CH.chat.steer);
  if (!handler) throw new Error("No handler for chat.steer");
  return handler(sender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  electronMock.__handlers.clear();
  registerChatSteerHandler();
  mocks.getSessionById.mockResolvedValue({
    ok: true,
    data: { id: SESSION_ID, mode: "agent" },
  });
  mocks.ensureEngineDbUrl.mockResolvedValue({ ok: true, data: undefined });
  mocks.submitSteeringMessage.mockResolvedValue({ outcome: "queued_live" });
});

describe("chat.steer IPC", () => {
  it("queued_live passes through: the engine persisted exactly one interrupt row", async () => {
    const result = await invoke({ sessionId: SESSION_ID, message: "steer" });
    expect(result).toEqual({ ok: true, data: { outcome: "queued_live" } });
    expect(mocks.submitSteeringMessage).toHaveBeenCalledTimes(1);
    expect(mocks.submitSteeringMessage).toHaveBeenCalledWith(SESSION_ID, "steer");
  });

  it("no_active_turn passes through so the renderer can fall back to a normal submit", async () => {
    mocks.submitSteeringMessage.mockResolvedValue({ outcome: "no_active_turn" });
    const result = await invoke({ sessionId: SESSION_ID, message: "steer" });
    expect(result).toEqual({ ok: true, data: { outcome: "no_active_turn" } });
  });

  it("an unknown session fails by name before the engine is reached", async () => {
    mocks.getSessionById.mockResolvedValue({ ok: true, data: null });
    const result = await invoke({ sessionId: SESSION_ID, message: "steer" });
    expect(result.ok).toBe(false);
    expect(mocks.submitSteeringMessage).not.toHaveBeenCalled();
  });

  it("message seam: 2000 chars pass, 2001 are rejected before the handler body runs", async () => {
    const ok2000 = await invoke({
      sessionId: SESSION_ID,
      message: "m".repeat(2000),
    });
    expect(ok2000.ok).toBe(true);
    const rejected = await invoke({
      sessionId: SESSION_ID,
      message: "m".repeat(2001),
    });
    expect(rejected.ok).toBe(false);
    expect(mocks.submitSteeringMessage).toHaveBeenCalledTimes(1);
  });

  it("the strict schema refuses a reasoningEffort rider - a steer joins the live turn's config", async () => {
    const result = await invoke({
      sessionId: SESSION_ID,
      message: "steer",
      reasoningEffort: "high",
    });
    expect(result.ok).toBe(false);
    expect(mocks.submitSteeringMessage).not.toHaveBeenCalled();
  });

  it("an engine throw surfaces classified, and the handler makes exactly one attempt", async () => {
    mocks.submitSteeringMessage.mockRejectedValue(new Error("provider down"));
    const result = await invoke({ sessionId: SESSION_ID, message: "steer" });
    expect(result.ok).toBe(false);
    expect(mocks.submitSteeringMessage).toHaveBeenCalledTimes(1);
  });
});
