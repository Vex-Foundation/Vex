/**
 * An OS notification main raises on its own, outside a turn (F01 price
 * alerts, and any later background event).
 *
 * Same rule as `ipc/system/notify-turn-complete.ts`: main measures focus
 * ITSELF, so nothing outside main can force a notification while Vex is
 * front-most, and an unsupported platform shows nothing. The caller decides
 * the words (and whether the vault lock hides them); this helper only shows
 * them and wires the click.
 */

import { BrowserWindow, Notification } from "electron";

export interface BackgroundNotice {
  readonly title: string;
  readonly body: string;
  /** Runs when the user clicks the notification. */
  readonly onClick?: () => void;
}

/** Show `notice` when no Vex window is focused. Returns whether it was shown. */
export function showBackgroundNotice(notice: BackgroundNotice): boolean {
  if (BrowserWindow.getFocusedWindow() !== null) return false;
  if (!Notification.isSupported()) return false;
  const shown = new Notification({ title: notice.title, body: notice.body });
  if (notice.onClick !== undefined) shown.on("click", notice.onClick);
  shown.show();
  return true;
}
