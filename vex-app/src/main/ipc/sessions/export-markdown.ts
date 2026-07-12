/** vex.sessions.exportMarkdown — native, path-private transcript export. */

import { BrowserWindow, dialog, type SaveDialogOptions } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { err, ok, type Result } from "@shared/ipc/result.js";
import {
  sessionExportMarkdownInputSchema,
  sessionExportMarkdownResultSchema,
  type SessionExportMarkdownResult,
} from "@shared/schemas/sessions.js";
import {
  getSessionById,
  getSessionExportMessages,
} from "../../database/sessions-db.js";
import { log } from "../../logger/index.js";
import {
  defaultSessionMarkdownFilename,
  renderSessionMarkdown,
  writeMarkdownAtomically,
} from "../../sessions/markdown-export.js";
import { registerHandler } from "../register-handler.js";

export function registerSessionsExportMarkdownHandler(): () => void {
  return registerHandler({
    channel: CH.sessions.exportMarkdown,
    domain: "sessions",
    inputSchema: sessionExportMarkdownInputSchema,
    outputSchema: sessionExportMarkdownResultSchema,
    handle: async (input, ctx): Promise<Result<SessionExportMarkdownResult>> => {
      const sessionResult = await getSessionById(input.id);
      if (!sessionResult.ok) return sessionResult;
      if (sessionResult.data === null) {
        return err({
          code: "internal.unexpected",
          domain: "sessions",
          message: "Session not found.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }

      const session = sessionResult.data;
      const parentWindow = BrowserWindow.fromWebContents(ctx.event.sender);
      const saveOptions: SaveDialogOptions = {
        title: "Export session as Markdown",
        defaultPath: defaultSessionMarkdownFilename(
          session.title ?? session.initialGoal,
          session.startedAt,
        ),
        filters: [{ name: "Markdown", extensions: ["md"] }],
        properties: ["showOverwriteConfirmation", "createDirectory"],
      };
      const dialogResult = parentWindow
        ? await dialog.showSaveDialog(parentWindow, saveOptions)
        : await dialog.showSaveDialog(saveOptions);
      if (dialogResult.canceled || !dialogResult.filePath) {
        return ok({ outcome: "cancelled" });
      }

      const messagesResult = await getSessionExportMessages(input.id);
      if (!messagesResult.ok) return messagesResult;
      try {
        const markdown = renderSessionMarkdown(session, messagesResult.data);
        await writeMarkdownAtomically(dialogResult.filePath, markdown);
        log.info(
          `[ipc:vex:sessions:exportMarkdown] saved messages=${messagesResult.data.length} correlationId=${ctx.requestId}`,
        );
        return ok({ outcome: "saved" });
      } catch (cause) {
        const causeType = cause instanceof Error ? cause.name : typeof cause;
        log.warn(
          `[ipc:vex:sessions:exportMarkdown] write failed causeType=${causeType} correlationId=${ctx.requestId}`,
        );
        return err({
          code: "internal.unexpected",
          domain: "sessions",
          message: "Unable to save the session transcript.",
          retryable: true,
          userActionable: true,
          redacted: true,
          correlationId: ctx.requestId,
        });
      }
    },
  });
}
