/**
 * Pure menu template builder for the macOS application menu.
 *
 * On macOS we cannot fully drop the system menu without breaking
 * Cmd+C/V/X/A/Z inside `<input>`/`<textarea>` — those accelerators are
 * wired through the Electron `editMenu` role, not by Chromium directly.
 * So we ship the smallest acceptable macOS menu: `appMenu` (Quit/Hide
 * required by the platform) + `editMenu` (clipboard accelerators) +
 * optional `viewMenu` in dev for DevTools toggling.
 *
 * On Windows/Linux the caller drops the menu outright with
 * `Menu.setApplicationMenu(null)` (clipboard accelerators are provided
 * by Chromium DOM handlers in editable elements), so this builder
 * returns `null` for them and is not used at runtime.
 *
 * Kept type-only on the Electron side so tests can import this module
 * without an Electron runtime (`import type` is erased at compile time).
 */

import type { MenuItemConstructorOptions } from "electron";
import { LOCK_BUTTON } from "@shared/lock-button.js";

export interface MenuTemplateOpts {
  readonly isMac: boolean;
  readonly isDev: boolean;
  readonly requestLock?: () => void;
  readonly lockEnabled?: boolean;
}

export function buildMacMenuTemplate(
  opts: MenuTemplateOpts,
): MenuItemConstructorOptions[] | null {
  if (!opts.isMac) return null;
  return [
    {
      role: "appMenu" as const,
      ...((opts.lockEnabled ?? LOCK_BUTTON) ? {
        submenu: [
          { role: "about" as const },
          { type: "separator" as const },
          { label: "Lock Vex", accelerator: "CommandOrControl+Shift+L", click: opts.requestLock },
          { type: "separator" as const },
          { role: "services" as const },
          { type: "separator" as const },
          { role: "hide" as const },
          { role: "hideOthers" as const },
          { role: "unhide" as const },
          { type: "separator" as const },
          { role: "quit" as const },
        ],
      } : {}),
    },
    { role: "editMenu" as const },
    ...(opts.isDev ? [{ role: "viewMenu" as const }] : []),
  ];
}
