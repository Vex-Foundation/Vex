/**
 * vex.system.notifyTurnComplete IPC handler.
 *
 * Contract under test: the OS notification fires ONLY while no app window has
 * focus - main asks Electron itself and never trusts the renderer's word for
 * it; the body carries the session title but the title is always "Vex"; the
 * title is validated by the shared session-title schema at the boundary (an
 * 80-char title passes, 81 is rejected before the handler body runs); an
 * unsupported platform reports shown:false rather than throwing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { IpcMainInvokeEvent } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender } from "./test-sender.js";

const mocks = vi.hoisted(() => ({
  getFocusedWindow: vi.fn((): unknown => null),
  isSupported: vi.fn(() => true),
  show: vi.fn(),
  constructed: [] as Array<{ title: string; body: string }>,
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("electron", () => {
  const handlers = new Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>();
  class FakeNotification {
    static isSupported = mocks.isSupported;
    constructor(options: { title: string; body: string }) {
      mocks.constructed.push(options);
    }
    show = mocks.show;
  }
  return {
    ipcMain: {
      handle: vi.fn((channel: string, fn: (e: IpcMainInvokeEvent, p: unknown) => unknown) =>
        handlers.set(channel, fn)),
      removeHandler: vi.fn((ch: string) => handlers.delete(ch)),
    },
    BrowserWindow: { getFocusedWindow: mocks.getFocusedWindow },
    Notification: FakeNotification,
    __handlers: handlers,
  };
});
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerSystemNotifyTurnCompleteHandler } = await import(
  "../system/notify-turn-complete.js"
);
const electronMock = (await import("electron")) as unknown as {
  __handlers: Map<string, (e: IpcMainInvokeEvent, p: unknown) => unknown>;
};

const sender = createTrustedSender({ sender: createTestWebContents() });

async function invoke(payload: unknown): Promise<any> {
  const handler = electronMock.__handlers.get(CH.system.notifyTurnComplete);
  if (!handler) throw new Error("No handler for system.notifyTurnComplete");
  return handler(sender as unknown as IpcMainInvokeEvent, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.constructed.length = 0;
  mocks.getFocusedWindow.mockReturnValue(null);
  mocks.isSupported.mockReturnValue(true);
  electronMock.__handlers.clear();
  registerSystemNotifyTurnCompleteHandler();
});

describe("system.notifyTurnComplete IPC", () => {
  it("shows an OS notification titled Vex with the session title in the body while unfocused", async () => {
    const result = await invoke({ sessionTitle: "Research" });
    expect(result).toEqual({ ok: true, data: { shown: true } });
    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.constructed[0]?.title).toBe("Vex");
    expect(mocks.constructed[0]?.body).toContain("Research");
    expect(mocks.show).toHaveBeenCalledTimes(1);
  });

  it("never notifies while a window has focus - main checks focus itself", async () => {
    mocks.getFocusedWindow.mockReturnValue({});
    const result = await invoke({ sessionTitle: "Research" });
    expect(result).toEqual({ ok: true, data: { shown: false } });
    expect(mocks.constructed).toHaveLength(0);
    expect(mocks.show).not.toHaveBeenCalled();
  });

  it("reports shown:false when OS notifications are unsupported, never throws", async () => {
    mocks.isSupported.mockReturnValue(false);
    const result = await invoke({ sessionTitle: "Research" });
    expect(result).toEqual({ ok: true, data: { shown: false } });
    expect(mocks.constructed).toHaveLength(0);
  });

  it("title seam: 80 chars pass the boundary, 81 are rejected before any notification", async () => {
    const eighty = "t".repeat(80);
    const ok80 = await invoke({ sessionTitle: eighty });
    expect(ok80.ok).toBe(true);
    const rejected = await invoke({ sessionTitle: "t".repeat(81) });
    expect(rejected.ok).toBe(false);
    // Exactly one notification total: the 81-char call never reached the body.
    expect(mocks.constructed).toHaveLength(1);
  });

  it("rejects an empty or whitespace-only title at the boundary", async () => {
    const result = await invoke({ sessionTitle: "   " });
    expect(result.ok).toBe(false);
    expect(mocks.constructed).toHaveLength(0);
  });
});
