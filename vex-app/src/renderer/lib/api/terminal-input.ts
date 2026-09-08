import type { Result } from "@shared/ipc/result.js";
import type { ReadClipboardContentValue, TerminalClipboardRefusal, TerminalFilePathValue } from "@shared/schemas/terminal-input.js";
import { TERMINAL_CLIPBOARD_MAX_LENGTH } from "@shared/schemas/terminal-input.js";

export function terminalClipboardErrorMessage(reason: TerminalClipboardRefusal): string {
  return reason === "terminal_clipboard_too_large"
    ? "Clipboard text exceeds Vex's terminal limit of 1,048,576 characters. Copy a smaller selection. Nothing was shortened."
    : "Vex could not access the clipboard. Try copying the content again.";
}

export class TerminalClipboardError extends Error {
  constructor(readonly reason: TerminalClipboardRefusal) {
    super(terminalClipboardErrorMessage(reason));
    this.name = "TerminalClipboardError";
  }
}

export async function readTerminalClipboardContent(): Promise<Exclude<ReadClipboardContentValue, { kind: "refused" }>> {
  try {
    const result = await window.vex.terminalInput.readClipboardContent();
    if (!result.ok) throw new TerminalClipboardError("terminal_clipboard_unavailable");
    if (result.data.kind === "refused") throw new TerminalClipboardError(result.data.reason);
    return result.data;
  } catch (error) {
    if (error instanceof TerminalClipboardError) throw error;
    throw new TerminalClipboardError("terminal_clipboard_unavailable");
  }
}

/** The terminal and OSC 52 share the same native clipboard boundary. */
export const terminalClipboard = {
  async readText(): Promise<string> {
    const result = await window.vex.terminalInput.readClipboardText();
    if (!result.ok) throw new TerminalClipboardError("terminal_clipboard_unavailable");
    if (result.data.kind === "refused") throw new TerminalClipboardError(result.data.reason);
    return result.data.text;
  },
  async writeText(text: string): Promise<void> {
    if (text.length > TERMINAL_CLIPBOARD_MAX_LENGTH) {
      throw new TerminalClipboardError("terminal_clipboard_too_large");
    }
    const result = await window.vex.terminalInput.writeClipboardText({ text });
    if (!result.ok) throw new TerminalClipboardError("terminal_clipboard_unavailable");
    if (result.data.kind === "refused") throw new TerminalClipboardError(result.data.reason);
  },
};

export async function triggerNativeTerminalPaste(): Promise<void> {
  const result = await window.vex.terminalInput.triggerPaste();
  if (!result.ok) throw new TerminalClipboardError("terminal_clipboard_unavailable");
  if (result.data.kind === "refused") throw new TerminalClipboardError(result.data.reason);
}

export function resolveTerminalFilePath(file: File): Result<TerminalFilePathValue> {
  return window.vex.files.getPathForFile(file);
}
