import type { Result } from "../../../ipc/result.js";
import type {
  ReadClipboardTextValue,
  ReadClipboardContentValue,
  WriteClipboardTextValue,
  TriggerTerminalPasteValue,
} from "../../../schemas/terminal-input.js";

/** Clipboard contents stay local. The bridge never exposes format names or Electron objects. */
export interface TerminalInputBridge {
  readonly readClipboardContent: () => Promise<Result<ReadClipboardContentValue>>;
  readonly readClipboardText: () => Promise<Result<ReadClipboardTextValue>>;
  readonly writeClipboardText: (input: { text: string }) => Promise<Result<WriteClipboardTextValue>>;
  /** Dispatch native paste to this window's focused terminal, including copied files. */
  readonly triggerPaste: () => Promise<Result<TriggerTerminalPasteValue>>;
}
