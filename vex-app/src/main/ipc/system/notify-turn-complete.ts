/**
 * vex.system.notifyTurnComplete - OS-native turn-complete notification (A34).
 *
 * Narrow contract: the renderer supplies ONLY the session title (bounded by
 * the shared `sessionTitleSchema`); main decides whether to notify by asking
 * Electron for the focused window ITSELF - a renderer claiming to be
 * unfocused can never force a notification while the app is front-most. The
 * notification title is always "Vex"; only the validated session title rides
 * in the body. Electron main-process `Notification` is unaffected by the
 * deny-all web permission handlers in `main/permissions.ts`.
 */

import { BrowserWindow, Notification } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  notifyTurnCompleteInputSchema,
  notifyTurnCompleteResultSchema,
  type NotifyTurnCompleteResult,
} from "@shared/schemas/system.js";
import { registerHandler } from "../register-handler.js";

export function registerSystemNotifyTurnCompleteHandler(): () => void {
  return registerHandler({
    channel: CH.system.notifyTurnComplete,
    domain: "system",
    inputSchema: notifyTurnCompleteInputSchema,
    outputSchema: notifyTurnCompleteResultSchema,
    handle: async (input): Promise<Result<NotifyTurnCompleteResult>> => {
      // Focus is main's own measurement, never the renderer's claim.
      if (BrowserWindow.getFocusedWindow() !== null) {
        return ok({ shown: false });
      }
      if (!Notification.isSupported()) {
        return ok({ shown: false });
      }
      new Notification({
        title: "Vex",
        body: `${input.sessionTitle} finished a turn`,
      }).show();
      return ok({ shown: true });
    },
  });
}
