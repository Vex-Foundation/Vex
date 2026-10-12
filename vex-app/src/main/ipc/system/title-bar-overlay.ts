/**
 * vex.system.setTitleBarOverlay - recolour the native window controls overlay
 * (Windows and Linux) after a theme change.
 *
 * Narrow contract: the renderer names only the theme id; the colours are
 * main-owned (`windows/chrome-options.ts`). The target is the SENDER's own
 * window, never one the renderer names. macOS has no overlay and a
 * native-frame window has none either, so both report `applied: false`.
 */

import { BrowserWindow } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  setTitleBarOverlayInputSchema,
  setTitleBarOverlayResultSchema,
  type SetTitleBarOverlayResult,
} from "@shared/schemas/system.js";
import { titleBarOverlayFor } from "../../windows/chrome-options.js";
import { registerHandler } from "../register-handler.js";

export function registerSystemTitleBarOverlayHandler(): () => void {
  return registerHandler({
    channel: CH.system.setTitleBarOverlay,
    domain: "system",
    inputSchema: setTitleBarOverlayInputSchema,
    outputSchema: setTitleBarOverlayResultSchema,
    handle: async (input, ctx): Promise<Result<SetTitleBarOverlayResult>> => {
      if (process.platform === "darwin") return ok({ applied: false });
      const win = BrowserWindow.fromWebContents(ctx.event.sender);
      if (win === null || win.isDestroyed()) return ok({ applied: false });
      try {
        win.setTitleBarOverlay(titleBarOverlayFor(input.theme));
      } catch {
        // A native-frame window has no overlay to recolour.
        return ok({ applied: false });
      }
      return ok({ applied: true });
    },
  });
}
