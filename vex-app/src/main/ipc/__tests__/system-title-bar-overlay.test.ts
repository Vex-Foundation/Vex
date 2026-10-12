/**
 * vex.system.setTitleBarOverlay IPC handler.
 *
 * Contract: only a theme id crosses the boundary; main recolours the SENDER's
 * own window with its own constants; macOS and native-frame windows report
 * applied:false instead of throwing; an off-union theme is rejected before
 * the handler body runs.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { createTestWebContents, createTrustedSender, type TestIpcEvent } from "./test-sender.js";

type Handler = (event: TestIpcEvent, raw: unknown) => Promise<unknown>;

const mocks = vi.hoisted(() => ({
  fromWebContents: vi.fn((): unknown => null),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const handlers = new Map<string, Handler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: Handler) => {
      handlers.set(channel, fn);
    },
    removeHandler: (channel: string) => {
      handlers.delete(channel);
    },
  },
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));

const { registerSystemTitleBarOverlayHandler } = await import("../system/title-bar-overlay.js");

const webContents = createTestWebContents();
const sender = createTrustedSender({ sender: webContents });
const originalPlatform = process.platform;

function setPlatform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value, configurable: true });
}

interface HandlerResult {
  ok: boolean;
  data?: unknown;
}

function isHandlerResult(value: unknown): value is HandlerResult {
  return typeof value === "object" && value !== null && "ok" in value;
}

async function invoke(payload: unknown): Promise<HandlerResult> {
  const handler = handlers.get(CH.system.setTitleBarOverlay);
  if (!handler) throw new Error("No handler for system.setTitleBarOverlay");
  const result = await handler(sender, {
    requestId: "11111111-1111-4111-8111-111111111111",
    payload,
  });
  if (!isHandlerResult(result)) throw new Error("handler returned a non-Result value");
  return result;
}

function fakeWindow(setTitleBarOverlay = vi.fn()) {
  return { isDestroyed: () => false, setTitleBarOverlay };
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  setPlatform("win32");
  registerSystemTitleBarOverlayHandler();
});
afterEach(() => setPlatform(originalPlatform));

describe("system.setTitleBarOverlay IPC", () => {
  it("recolours the sender's window with the main-owned colours", async () => {
    const win = fakeWindow();
    mocks.fromWebContents.mockReturnValue(win);
    const result = await invoke({ theme: "celeris" });
    expect(result).toEqual({ ok: true, data: { applied: true } });
    expect(mocks.fromWebContents).toHaveBeenCalledWith(webContents);
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 44,
      color: "#F3F4F7",
      symbolColor: "#0A0D18",
    });
  });

  it("uses the dark plate for chronos", async () => {
    const win = fakeWindow();
    mocks.fromWebContents.mockReturnValue(win);
    await invoke({ theme: "chronos" });
    expect(win.setTitleBarOverlay).toHaveBeenCalledWith({
      height: 44,
      color: "#1B1412",
      symbolColor: "#F3F4F7",
    });
  });

  it("reports applied:false on macOS without touching the window", async () => {
    setPlatform("darwin");
    const win = fakeWindow();
    mocks.fromWebContents.mockReturnValue(win);
    expect(await invoke({ theme: "chronos" })).toEqual({ ok: true, data: { applied: false } });
    expect(win.setTitleBarOverlay).not.toHaveBeenCalled();
  });

  it("reports applied:false when there is no window or the call throws (native frame)", async () => {
    mocks.fromWebContents.mockReturnValue(null);
    expect(await invoke({ theme: "chronos" })).toEqual({ ok: true, data: { applied: false } });
    mocks.fromWebContents.mockReturnValue(
      fakeWindow(vi.fn(() => { throw new Error("no overlay"); })),
    );
    expect(await invoke({ theme: "chronos" })).toEqual({ ok: true, data: { applied: false } });
  });

  it("rejects an off-union theme or extra keys at the boundary", async () => {
    mocks.fromWebContents.mockReturnValue(fakeWindow());
    expect((await invoke({ theme: "#ff0000" })).ok).toBe(false);
    expect((await invoke({ theme: "chronos", color: "#fff" })).ok).toBe(false);
    expect(mocks.fromWebContents).not.toHaveBeenCalled();
  });
});
