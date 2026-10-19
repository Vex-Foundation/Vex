/**
 * Single instance lock: a second app instance is rejected and the existing
 * window is focused.
 *
 * Critical for the shared vault, keystore, and DB: two processes writing
 * concurrently to secrets.vault.json, .env, keystore.json, or preferences.json
 * would risk races, corrupted state, and double unlock.
 *
 * Skill §10 implicit: "user app instance owns local infra contract".
 */

import { app } from "electron";
import { getMainWindow } from "../windows/main-window-ref.js";

/**
 * @returns true if this is the primary instance and execution should continue.
 * @returns false if a primary instance is already running — caller MUST app.quit() immediately.
 */
export function acquireSingleInstanceLock(): boolean {
  const acquired = app.requestSingleInstanceLock();

  if (!acquired) {
    return false;
  }

  app.on("second-instance", () => {
    // The MAIN window: the first live window may be a hidden helper's.
    const primary = getMainWindow();
    if (primary) {
      if (primary.isMinimized()) primary.restore();
      primary.focus();
    }
  });

  return true;
}
