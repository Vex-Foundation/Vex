/**
 * Closing the main window quits on win32/linux even while a hidden helper
 * window (the DexScreener site bridge) is still open, which is exactly when
 * `window-all-closed` never fires. macOS keeps its dock semantics.
 */

import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ app: { on: vi.fn(), quit: vi.fn() } }));

const { quitWhenMainWindowCloses } = await import("../window-all-closed.js");

function fakeWindow(): EventEmitter & { once(event: "closed", listener: () => void): unknown } {
  return new EventEmitter();
}

describe("quitWhenMainWindowCloses", () => {
  it.each(["win32", "linux"] as const)("quits on %s when the main window closes", (platform) => {
    const window = fakeWindow();
    const quit = vi.fn();
    quitWhenMainWindowCloses(window, { platform, quit });

    expect(quit).not.toHaveBeenCalled();
    window.emit("closed");
    expect(quit).toHaveBeenCalledTimes(1);
  });

  it("keeps the app alive on darwin (the dock reopens it)", () => {
    const window = fakeWindow();
    const quit = vi.fn();
    quitWhenMainWindowCloses(window, { platform: "darwin", quit });

    window.emit("closed");
    expect(quit).not.toHaveBeenCalled();
    expect(window.listenerCount("closed")).toBe(0);
  });
});
