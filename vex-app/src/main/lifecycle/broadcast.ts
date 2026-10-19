/**
 * Broadcast a payload to every live BrowserWindow's webContents.
 *
 * Centralizes the `getAllWindows() → isDestroyed() → webContents.send`
 * loop that was previously copy-pasted at each IPC handler site that
 * pushes progress (database migration progress, the local runtime).
 * Per skill §11, the destroyed-window guard is mandatory — sending to
 * a destroyed webContents throws and bypasses the cleanup registry.
 *
 * Channel string is opaque to this helper; callers must use the typed
 * `EV.<domain>.<topic>` constants from `@shared/ipc/channels.js`.
 */

import { BrowserWindow } from "electron";

export function broadcastToAllWindows(
  channel: string,
  payload: unknown
): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}
