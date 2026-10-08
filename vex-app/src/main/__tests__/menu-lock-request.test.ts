import { beforeEach, describe, expect, it, vi } from "vitest";
import { EV } from "@shared/ipc/channels.js";
const send = vi.fn();
const destroyed = vi.fn(() => false);
const contentsDestroyed = vi.fn(() => false);
const window = { isDestroyed: destroyed, webContents: { send, isDestroyed: contentsDestroyed } };
const focused = vi.fn<() => typeof window | null>(() => window);
vi.mock("electron", () => ({ BrowserWindow: { getFocusedWindow: focused }, Menu: {}, app: {} }));
const feature = vi.hoisted(() => ({ enabled: true }));
vi.mock("@shared/lock-button.js", () => ({ get LOCK_BUTTON() { return feature.enabled; } }));
const { requestFocusedWindowLock } = await import("../menu.js");
beforeEach(() => {
  feature.enabled = true;
  send.mockReset();
  destroyed.mockReturnValue(false);
  contentsDestroyed.mockReturnValue(false);
  focused.mockReturnValue(window);
});
describe("native Lock Vex", () => {
  it("requests lock from only the focused window with an empty validated payload", () => {
    requestFocusedWindowLock();
    expect(send).toHaveBeenCalledExactlyOnceWith(EV.secrets.lockRequested, {});
  });
  it("ignores missing or destroyed windows and respects the rollback flag", () => {
    focused.mockReturnValue(null);
    requestFocusedWindowLock();
    focused.mockReturnValue(window);
    destroyed.mockReturnValue(true);
    requestFocusedWindowLock();
    destroyed.mockReturnValue(false);
    contentsDestroyed.mockReturnValue(true);
    requestFocusedWindowLock();
    contentsDestroyed.mockReturnValue(false);
    feature.enabled = false;
    requestFocusedWindowLock();
    expect(send).not.toHaveBeenCalled();
  });
});
