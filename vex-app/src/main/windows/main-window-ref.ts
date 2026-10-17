/**
 * THE main window, as opposed to "a window".
 *
 * Helper windows are BrowserWindows too: the DexScreener site bridge keeps a
 * hidden one for the life of the app. So `BrowserWindow.getAllWindows()` is
 * never empty once it exists, and its first entry is not necessarily the
 * window the user sees. Code that means the main window asks here.
 */

import type { BrowserWindow } from "electron";

let current: BrowserWindow | null = null;

export function setMainWindow(window: BrowserWindow): void {
  current = window;
  window.once("closed", () => {
    if (current === window) current = null;
  });
}

/** The live main window, or `null` when it was closed (or never opened). */
export function getMainWindow(): BrowserWindow | null {
  return current !== null && !current.isDestroyed() ? current : null;
}
