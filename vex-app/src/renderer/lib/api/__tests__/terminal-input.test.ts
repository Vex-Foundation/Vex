import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TERMINAL_CLIPBOARD_MAX_LENGTH } from "@shared/schemas/terminal-input.js";
import { readTerminalClipboardContent, terminalClipboard, TerminalClipboardError, triggerNativeTerminalPaste } from "../terminal-input.js";

const readClipboardContent = vi.fn();
const readClipboardText = vi.fn();
const writeClipboardText = vi.fn();
const triggerPaste = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("vex", { terminalInput: { readClipboardContent, readClipboardText, writeClipboardText, triggerPaste } });
});
afterEach(() => vi.unstubAllGlobals());

describe("terminal native clipboard adapter", () => {
  it.each([
    { kind: "text", text: "exact text\n" },
    { kind: "files" },
    { kind: "image" },
    { kind: "empty" },
  ])("preserves content classification without a browser clipboard call", async (data) => {
    readClipboardContent.mockResolvedValueOnce({ ok: true, data });
    expect(await readTerminalClipboardContent()).toEqual(data);
    expect(readClipboardContent).toHaveBeenCalledExactlyOnceWith();
  });

  it("preserves named oversize refusal for a Vex notice", async () => {
    readClipboardContent.mockResolvedValueOnce({ ok: true, data: { kind: "refused", reason: "terminal_clipboard_too_large" } });
    await expect(readTerminalClipboardContent()).rejects.toMatchObject({ reason: "terminal_clipboard_too_large" });
  });

  it("maps failed and rejected bridge requests to a safe clipboard error", async () => {
    readClipboardContent.mockResolvedValueOnce({ ok: false, error: { code: "internal.cancelled" } });
    await expect(readTerminalClipboardContent()).rejects.toEqual(new TerminalClipboardError("terminal_clipboard_unavailable"));
    readClipboardContent.mockRejectedValueOnce(new Error("private native exception"));
    await expect(readTerminalClipboardContent()).rejects.toEqual(new TerminalClipboardError("terminal_clipboard_unavailable"));
  });

  it("retains exact native text access for OSC 52 and selected-text copy", async () => {
    readClipboardText.mockResolvedValueOnce({ ok: true, data: { kind: "text", text: "exact\n" } });
    expect(await terminalClipboard.readText()).toBe("exact\n");
    writeClipboardText.mockResolvedValueOnce({ ok: true, data: { kind: "written" } });
    await terminalClipboard.writeText("selection\n");
    expect(writeClipboardText).toHaveBeenCalledExactlyOnceWith({ text: "selection\n" });
  });

  it("refuses oversize selection before crossing preload", async () => {
    await expect(terminalClipboard.writeText("x".repeat(TERMINAL_CLIPBOARD_MAX_LENGTH + 1))).rejects.toMatchObject({ reason: "terminal_clipboard_too_large" });
    expect(writeClipboardText).not.toHaveBeenCalled();
  });

  it("surfaces native file-paste refusal", async () => {
    triggerPaste.mockResolvedValueOnce({ ok: true, data: { kind: "refused", reason: "terminal_clipboard_unavailable" } });
    await expect(triggerNativeTerminalPaste()).rejects.toMatchObject({ reason: "terminal_clipboard_unavailable" });
  });
});
