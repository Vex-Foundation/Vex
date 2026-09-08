import { registerTerminalClipboardFileHandlers } from "./terminal-clipboard-files.js";
import { clipboard } from "electron";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  readClipboardContentInputSchema,
  readClipboardContentValueSchema,
  type ReadClipboardContentValue,
  readClipboardTextInputSchema,
  readClipboardTextValueSchema,
  writeClipboardTextInputSchema,
  writeClipboardTextValueSchema,
  TERMINAL_CLIPBOARD_MAX_LENGTH,
  type ReadClipboardTextValue,
  type WriteClipboardTextValue,
} from "@shared/schemas/terminal-input.js";
import { AbortError } from "./cancel-helpers.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

async function checkActiveWindow(ctx: HandlerContext): Promise<void> {
  // Give an already-issued cancellation a chance before the synchronous native effect.
  await Promise.resolve();
  if (ctx.signal.aborted || ctx.event.sender.isDestroyed()) throw new AbortError();
}

export function registerTerminalInputHandlers(): Array<() => void> {
  return [
    registerHandler({
      channel: CH.terminalInput.readClipboardContent,
      domain: "studio",
      inputSchema: readClipboardContentInputSchema,
      outputSchema: readClipboardContentValueSchema,
      handle: async (_input, ctx): Promise<Result<ReadClipboardContentValue>> => {
        await checkActiveWindow(ctx);
        try {
          const text = clipboard.readText();
          if (text.length > TERMINAL_CLIPBOARD_MAX_LENGTH) {
            return ok({ kind: "refused", reason: "terminal_clipboard_too_large" });
          }
          if (text.length > 0) return ok({ kind: "text", text });
          // Chromium normalizes Finder and Explorer file formats to text/uri-list.
          // Files precede images because Finder also places a file icon on the clipboard.
          if (clipboard.availableFormats().includes("text/uri-list")) return ok({ kind: "files" });
          return ok({ kind: clipboard.readImage().isEmpty() ? "empty" : "image" });
        } catch {
          return ok({ kind: "refused", reason: "terminal_clipboard_unavailable" });
        }
      },
    }),
    registerHandler({
      channel: CH.terminalInput.readClipboardText,
      domain: "studio",
      inputSchema: readClipboardTextInputSchema,
      outputSchema: readClipboardTextValueSchema,
      handle: async (_input, ctx): Promise<Result<ReadClipboardTextValue>> => {
        await checkActiveWindow(ctx);
        try {
          const text = clipboard.readText();
          return text.length > TERMINAL_CLIPBOARD_MAX_LENGTH
            ? ok({ kind: "refused", reason: "terminal_clipboard_too_large" })
            : ok({ kind: "text", text });
        } catch {
          return ok({ kind: "refused", reason: "terminal_clipboard_unavailable" });
        }
      },
    }),
    registerHandler({
      channel: CH.terminalInput.writeClipboardText,
      domain: "studio",
      inputSchema: writeClipboardTextInputSchema,
      outputSchema: writeClipboardTextValueSchema,
      handle: async (input, ctx): Promise<Result<WriteClipboardTextValue>> => {
        await checkActiveWindow(ctx);
        if (input.text.length > TERMINAL_CLIPBOARD_MAX_LENGTH) {
          return ok({ kind: "refused", reason: "terminal_clipboard_too_large" });
        }
        try {
          clipboard.writeText(input.text);
          return ok({ kind: "written" });
        } catch {
          return ok({ kind: "refused", reason: "terminal_clipboard_unavailable" });
        }
      },
    }),
    ...registerTerminalClipboardFileHandlers(),
  ];
}
