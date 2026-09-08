import { readClipboardFilesInputSchema, readClipboardFilesValueSchema, type ReadClipboardFilesValue } from "../../shared/schemas/terminal-clipboard-files.js";
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
} from "../../shared/schemas/terminal-input.js";
import type { TerminalInputBridge } from "../../shared/types/bridge/shell/terminal-input.js";
import { abortableInvoke, invokeWithSchema } from "../_dispatch.js";

async function checkedClipboard<O>(pending: Promise<Result<unknown>>, outputSchema: z.ZodType<O>): Promise<Result<O>> {
  try {
    const result = await pending;
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

function invokeClipboard<I, O>(channel: string, input: I, inputSchema: z.ZodType<I>, outputSchema: z.ZodType<O>): Promise<Result<O>> {
  return checkedClipboard(invokeWithSchema<unknown, I>(channel, input, inputSchema), outputSchema);
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
  readClipboardFiles() {
    const invocation = abortableInvoke<ReadClipboardFilesValue>(CH.terminalInput.readClipboardFiles, {}, readClipboardFilesInputSchema);
    return { promise: checkedClipboard(invocation.promise, readClipboardFilesValueSchema), cancel: invocation.cancel };
  },
} satisfies TerminalInputBridge;
