/**
 * THE main window, as opposed to "a window".
 *
 * Helper windows are BrowserWindows too: the DexScreener site bridge keeps a
 * hidden one for the life of the app. So `BrowserWindow.getAllWindows()` is
 * never empty once it exists, and its first entry is not necessarily the
 * window the user sees. Code that means the main window asks here.
 */

import type { BrowserWindow } from "electron";

/** What the reference reads of a window: its `closed` event and whether it is destroyed. */
export interface ClosableWindow {
  once(event: "closed", listener: () => void): unknown;
  isDestroyed(): boolean;
}

export function createWindowRef<W extends ClosableWindow>(): {
  readonly set: (window: W) => void;
  readonly get: () => W | null;
} {
  let current: W | null = null;
  return {
    set: (window) => {
      current = window;
      window.once("closed", () => {
        if (current === window) current = null;
      });
    },
    get: () => (current !== null && !current.isDestroyed() ? current : null),
  };
}

const mainWindow = createWindowRef<BrowserWindow>();

export function setMainWindow(window: BrowserWindow): void {
  mainWindow.set(window);
}

/** The live main window, or `null` when it was closed (or never opened). */
export function getMainWindow(): BrowserWindow | null {
  return mainWindow.get();
}

let mainWindowOpener: (() => Promise<BrowserWindow>) | null = null;

/**
 * The entry registers the window factory once, so a leaf module can reopen the
 * window without importing `main-window.ts`. Importing it from anywhere but
 * the entry, even lazily, makes it a shared chunk and carries the `app://`
 * scheme registration out of `dist/main/index.js`, where it must run before
 * the app is ready (`scripts/check-privileged-bundles.mjs`).
 */
export function setMainWindowOpener(open: () => Promise<BrowserWindow>): void {
  mainWindowOpener = open;
}

/** A new main window from the registered factory; `null` before the entry registered one. */
export async function openMainWindow(): Promise<BrowserWindow | null> {
  return mainWindowOpener === null ? null : mainWindowOpener();
}
