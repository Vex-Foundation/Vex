import type { ReadClipboardFilesValue } from "../../../schemas/terminal-clipboard-files.js";
import type { AbortableInvocation } from "../common.js";
import type { Result } from "../../../ipc/result.js";
import type {
  ReadClipboardTextValue,
  ReadClipboardContentValue,
  WriteClipboardTextValue,
} from "../../../schemas/terminal-input.js";

/** Clipboard contents stay local. The bridge never exposes format names or Electron objects. */
export interface TerminalInputBridge {
  readonly readClipboardContent: () => Promise<Result<ReadClipboardContentValue>>;
  readonly readClipboardText: () => Promise<Result<ReadClipboardTextValue>>;
  readonly writeClipboardText: (input: { text: string }) => Promise<Result<WriteClipboardTextValue>>;
  /** Resolve a native file clipboard in a request-owned decoder window. */
  readonly readClipboardFiles: () => AbortableInvocation<ReadClipboardFilesValue>;
}
