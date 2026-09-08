import { z } from "zod";
import { CH } from "../../shared/ipc/channels.js";
import { err, ok, VEX_ERROR_CODES, type Result } from "../../shared/ipc/result.js";
import {
  readClipboardContentInputSchema,
  readClipboardContentValueSchema,
  readClipboardTextInputSchema,
  readClipboardTextValueSchema,
  writeClipboardTextInputSchema,
  writeClipboardTextValueSchema,
  triggerTerminalPasteInputSchema,
  triggerTerminalPasteValueSchema,
} from "../../shared/schemas/terminal-input.js";
import type { TerminalInputBridge } from "../../shared/types/bridge/shell/terminal-input.js";
import { invokeWithSchema } from "../_dispatch.js";

async function invokeClipboard<I, O>(
  channel: string,
  input: I,
  inputSchema: z.ZodType<I>,
  outputSchema: z.ZodType<O>,
): Promise<Result<O>> {
  try {
    const result = await invokeWithSchema<unknown, I>(channel, input, inputSchema);
    if (result.ok) {
      const parsed = outputSchema.safeParse(result.data);
      if (parsed.success) return ok(parsed.data);
    } else {
      const code = z.enum(VEX_ERROR_CODES).safeParse(result.error.code);
      const correlation = z.string().uuid().safeParse(result.error.correlationId);
      if (code.success) {
        return err({
          code: code.data,
          domain: "preload",
          message: "Vex could not complete the clipboard request.",
          retryable: false,
          userActionable: true,
          redacted: true,
          correlationId: correlation.success ? correlation.data : crypto.randomUUID(),
        });
      }
    }
  } catch {
    // A stopped main process must not expose a native exception to the renderer.
  }
  return err({
    code: "internal.contract_violation",
    domain: "preload",
    message: "Vex's clipboard connection is unavailable. Try again.",
    retryable: true,
    userActionable: true,
    redacted: true,
    correlationId: crypto.randomUUID(),
  });
}

export const terminalInput = {
  readClipboardContent() {
    return invokeClipboard(CH.terminalInput.readClipboardContent, {}, readClipboardContentInputSchema, readClipboardContentValueSchema);
  },
  readClipboardText() {
    return invokeClipboard(CH.terminalInput.readClipboardText, {}, readClipboardTextInputSchema, readClipboardTextValueSchema);
  },
  writeClipboardText(input) {
    return invokeClipboard(CH.terminalInput.writeClipboardText, input, writeClipboardTextInputSchema, writeClipboardTextValueSchema);
  },
  triggerPaste() {
    return invokeClipboard(CH.terminalInput.triggerPaste, {}, triggerTerminalPasteInputSchema, triggerTerminalPasteValueSchema);
  },
} satisfies TerminalInputBridge;
