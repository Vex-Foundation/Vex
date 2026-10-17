/**
 * Standard macOS dock semantics: app stays alive when all windows are closed
 * on darwin (user re-opens via dock); quit on win32/linux.
 *
 * `window-all-closed` alone does not deliver the win32/linux half: Electron
 * fires it only when EVERY BrowserWindow is gone, hidden ones included, and the
 * DexScreener site bridge keeps a hidden window for the life of the app. With
 * only that hook, closing Vex's window on Windows or Linux left the process
 * running with no window, and with the native runtime its Postgres and
 * llama-server with it. So the main window's own close quits there too
 * ({@link quitWhenMainWindowCloses}); the hook stays for the darwin half,
 * because without a listener Electron would quit on every platform.
 */

import { app } from "electron";

export function installWindowAllClosedHook(): void {
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") {
      app.quit();
    }
  });
}

interface ClosableWindow {
  once(event: "closed", listener: () => void): unknown;
}

/** On win32/linux, closing the main window is quitting the app. */
export function quitWhenMainWindowCloses(
  window: ClosableWindow,
  deps: { readonly platform: NodeJS.Platform; readonly quit: () => void } = {
    platform: process.platform,
    quit: () => app.quit(),
  },
): void {
  if (deps.platform === "darwin") return;
  window.once("closed", () => deps.quit());
}
