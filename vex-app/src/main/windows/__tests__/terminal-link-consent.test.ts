import { EventEmitter } from "node:events";
import type { BrowserWindow, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ windows: [] as FakeWindow[], options: [] as unknown[], packaged: true, parent: {
  isDestroyed: vi.fn(() => false), focus: vi.fn(), webContents: { focus: vi.fn() },
} }));
class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
  loadURL = vi.fn(async (_url: string) => undefined);
  show = vi.fn(); focus = vi.fn();
  isDestroyed(): boolean { return this.destroyed; }
  close(): void { this.destroyed = true; this.emit("closed"); }
  constructor(options: unknown) { super(); mocks.options.push(options); mocks.windows.push(this); }
}
vi.mock("electron", () => ({ app: { get isPackaged() { return mocks.packaged; } }, BrowserWindow: class extends FakeWindow {
  static fromWebContents(): unknown { return mocks.parent; }
} }));
vi.mock("../../protocol/app-protocol.js", () => ({ APP_ORIGIN: "app://vex" }));
const { createTerminalLinkConsentWindow } = await import("../terminal-link-consent.js");
const proposal = { id: "11111111-1111-4111-8111-111111111111", url: "https://example.com/a?x=two%2Bthree", host: { ascii: "example.com", display: "example.com" }, expiresAt: Date.now() + 1000 };
beforeEach(() => { vi.clearAllMocks(); mocks.windows.length = 0; mocks.options.length = 0; mocks.packaged = true; });
function create(): BrowserWindow { return createTerminalLinkConsentWindow({} as WebContents, proposal); }
describe("isolated terminal consent window", () => {
  it("loads only the dedicated app page with its own sandbox preload and the complete proposal", () => {
    create();
    expect(mocks.options[0]).toMatchObject({ parent: mocks.parent, modal: true, frame: false, show: false,
      webPreferences: { preload: expect.stringMatching(/terminal-link-consent\.cjs$/), contextIsolation: true,
        sandbox: true, nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
        webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false } });
    const window = mocks.windows[0]!;
    const url = window.loadURL.mock.calls[0]![0];
    expect(url.startsWith("app://vex/terminal-link-consent.html#")).toBe(true);
    expect(JSON.parse(decodeURIComponent(url.split("#")[1]!))).toEqual(proposal);
    expect(window.show).not.toHaveBeenCalled(); window.emit("ready-to-show");
    expect(window.show).toHaveBeenCalledTimes(1); expect(window.focus).toHaveBeenCalledTimes(1);
  });
  it.each(["will-navigate", "will-redirect"])("blocks %s and restores parent terminal window focus on close", eventName => {
    create(); const window = mocks.windows[0]!; const event = { preventDefault: vi.fn() };
    window.webContents.emit(eventName, event, "https://evil.example");
    expect(event.preventDefault).toHaveBeenCalledTimes(1); expect(window.isDestroyed()).toBe(true);
    expect(mocks.parent.focus).toHaveBeenCalledTimes(1); expect(mocks.parent.webContents.focus).toHaveBeenCalledTimes(1);
  });
  it("denies popup creation without forwarding it to a browser", () => {
    create(); const handler = mocks.windows[0]!.webContents.setWindowOpenHandler.mock.calls[0]![0] as () => unknown;
    expect(handler()).toEqual({ action: "deny" });
  });
});
