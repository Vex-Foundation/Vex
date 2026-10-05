/**
 * Application menu install policy.
 *
 * Vex is a runtime-style desktop app — the default File/Edit/View/Window
 * menu is visual noise. We strip it differently per platform:
 *
 *   - Windows/Linux: `Menu.setApplicationMenu(null)` — fully removes the
 *     window's menu bar. `autoHideMenuBar` + `setMenuBarVisibility(false)`
 *     would leave Alt as a re-show fallback, which we do not want.
 *
 *   - macOS: a minimal `appMenu + editMenu (+ viewMenu in dev)` template.
 *     macOS *requires* a system menu bar at the top of the screen, and
 *     setting it to null breaks clipboard accelerators in text inputs.
 *
 * Must be called inside `app.whenReady()` before any BrowserWindow opens.
 */

import { BrowserWindow, Menu, app } from "electron";
import { EV } from "@shared/ipc/channels.js";
import { LOCK_BUTTON } from "@shared/lock-button.js";
import { secretsLockInputSchema } from "@shared/schemas/secrets.js";
import { buildMacMenuTemplate } from "./menu-template.js";

export function installMinimalMenu(): void {
  const isMac = process.platform === "darwin";
  const isDev = !app.isPackaged;
  if (isMac) {
    const template = buildMacMenuTemplate({ isMac, isDev, requestLock: requestFocusedWindowLock });
    if (template === null) return;
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
    return;
  }
  Menu.setApplicationMenu(null);
}

/** Only asks the focused renderer; secret teardown remains in the existing IPC. */
export function requestFocusedWindowLock(): void {
  if (!LOCK_BUTTON) return;
  const window = BrowserWindow.getFocusedWindow();
  if (window === null || window.isDestroyed() || window.webContents.isDestroyed()) return;
  window.webContents.send(EV.secrets.lockRequested, secretsLockInputSchema.parse({}));
}
