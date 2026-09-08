import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { TERMINAL_CLIPBOARD_MAX_LENGTH, TERMINAL_CLIPBOARD_TRANSPORT_MAX } from "@shared/schemas/terminal-input.js";
import { createTrustedSender } from "./test-sender.js";

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, input: unknown) => Promise<unknown>>(),
  readText: vi.fn<() => unknown>(() => "clipboard text"),
  writeText: vi.fn(),
  availableFormats: vi.fn<() => string[]>(() => []),
  readImage: vi.fn<() => { isEmpty: () => boolean }>(() => ({ isEmpty: () => true })),
  paste: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("electron", () => ({
  clipboard: { readText: mocks.readText, writeText: mocks.writeText, availableFormats: mocks.availableFormats, readImage: mocks.readImage },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, input: unknown) => Promise<unknown>) => mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
const { registerTerminalInputHandlers } = await import("../terminal-input.js");
const { getCancelController } = await import("../register-handler.js");

let cleanup: Array<() => void> = [];
beforeEach(() => {
  vi.clearAllMocks();
  mocks.readText.mockReturnValue("clipboard text");
  mocks.availableFormats.mockReturnValue([]);
  mocks.readImage.mockReturnValue({ isEmpty: () => true });
  cleanup = registerTerminalInputHandlers();
});
afterEach(() => cleanup.forEach((dispose) => dispose()));

function sender(destroyed = false) {
  return createTrustedSender({ sender: { isDestroyed: () => destroyed, paste: mocks.paste } });
}
function call(channel: string, payload: unknown = {}, event: unknown = sender()): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (!handler) throw new Error("Clipboard handler was not registered");
  return handler(event, { requestId: "clipboard-request", payload });
}

describe("native terminal clipboard", () => {
  it("prefers nonempty text to files and images", async () => {
    mocks.availableFormats.mockReturnValue(["text/uri-list", "image/png"]);
    mocks.readImage.mockReturnValue({ isEmpty: () => false });
    expect(await call(CH.terminalInput.readClipboardContent)).toEqual({ ok: true, data: { kind: "text", text: "clipboard text" } });
    expect(mocks.availableFormats).not.toHaveBeenCalled();
    expect(mocks.readImage).not.toHaveBeenCalled();
  });

  it("classifies file clipboard data before a copied file icon image", async () => {
    mocks.readText.mockReturnValue("");
    mocks.availableFormats.mockReturnValue(["text/uri-list", "image/png"]);
    mocks.readImage.mockReturnValue({ isEmpty: () => false });
    expect(await call(CH.terminalInput.readClipboardContent)).toEqual({ ok: true, data: { kind: "files" } });
    expect(mocks.readImage).not.toHaveBeenCalled();
  });

  it("distinguishes a screenshot from an empty clipboard without exporting image bytes", async () => {
    mocks.readText.mockReturnValue("");
    mocks.availableFormats.mockReturnValue(["image/png"]);
    mocks.readImage.mockReturnValue({ isEmpty: () => false });
    expect(await call(CH.terminalInput.readClipboardContent)).toEqual({ ok: true, data: { kind: "image" } });
    mocks.readImage.mockReturnValue({ isEmpty: () => true });
    expect(await call(CH.terminalInput.readClipboardContent)).toEqual({ ok: true, data: { kind: "empty" } });
  });

  it.each([mocks.availableFormats, mocks.readImage])("redacts clipboard classification failure", async (operation) => {
    mocks.readText.mockReturnValue("");
    operation.mockImplementationOnce(() => { throw new Error("private clipboard content"); });
    expect(await call(CH.terminalInput.readClipboardContent)).toEqual({ ok: true, data: { kind: "refused", reason: "terminal_clipboard_unavailable" } });
    expect(mocks.log.error).not.toHaveBeenCalled();
  });

  it("reads and writes exact text through native clipboard, including empty text", async () => {
    expect(await call(CH.terminalInput.readClipboardText)).toEqual({ ok: true, data: { kind: "text", text: "clipboard text" } });
    const text = "héllo\n\u001b[31m";
    expect(await call(CH.terminalInput.writeClipboardText, { text })).toEqual({ ok: true, data: { kind: "written" } });
    expect(mocks.writeText).toHaveBeenCalledExactlyOnceWith(text);
    mocks.readText.mockReturnValue("");
    expect(await call(CH.terminalInput.readClipboardText)).toEqual({ ok: true, data: { kind: "text", text: "" } });
  });

  it("accepts clipboard reads from another trusted Vex window but rejects a non-Vex sender", async () => {
    const other = createTrustedSender({ sender: { id: 77, isDestroyed: () => false } });
    expect(await call(CH.terminalInput.readClipboardText, {}, other)).toEqual({ ok: true, data: { kind: "text", text: "clipboard text" } });
    const untrusted = { ...other, senderFrame: { url: "https://untrusted.example/", parent: null, top: null } };
    expect(await call(CH.terminalInput.readClipboardText, {}, untrusted)).toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    expect(mocks.readText).toHaveBeenCalledTimes(1);
  });

  it("refuses oversize content by name without shortening or overwriting the clipboard", async () => {
    const text = "a".repeat(TERMINAL_CLIPBOARD_MAX_LENGTH + 1);
    mocks.readText.mockReturnValue(text);
    const refusal = { ok: true, data: { kind: "refused", reason: "terminal_clipboard_too_large" } };
    expect(await call(CH.terminalInput.readClipboardContent)).toEqual(refusal);
    expect(await call(CH.terminalInput.readClipboardText)).toEqual(refusal);
    expect(await call(CH.terminalInput.writeClipboardText, { text })).toEqual(refusal);
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(await call(CH.terminalInput.writeClipboardText, { text: "a".repeat(TERMINAL_CLIPBOARD_TRANSPORT_MAX + 1) })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
  });

  it("accepts text exactly at the product bound", async () => {
    const text = "a".repeat(TERMINAL_CLIPBOARD_MAX_LENGTH);
    mocks.readText.mockReturnValue(text);
    expect(await call(CH.terminalInput.readClipboardText)).toEqual({ ok: true, data: { kind: "text", text } });
    expect(await call(CH.terminalInput.writeClipboardText, { text })).toEqual({ ok: true, data: { kind: "written" } });
  });

  it.each([
    [CH.terminalInput.readClipboardContent, {}],
    [CH.terminalInput.readClipboardText, {}],
    [CH.terminalInput.writeClipboardText, { text: "hello" }],
  ])("validates input, sender, subframes and cancellation for %s", async (channel, payload) => {
    expect(await call(channel, { ...payload, format: "private" })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(await call(channel, payload, { ...sender(), senderFrame: { url: "https://other.example", parent: null, top: null } })).toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    const trusted = sender();
    expect(await call(channel, payload, { ...trusted, senderFrame: { ...trusted.senderFrame, parent: trusted.senderFrame } })).toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    expect(await call(channel, payload, sender(true))).toMatchObject({ ok: false, error: { code: "internal.cancelled" } });
    const pending = call(channel, payload);
    const controller = getCancelController("clipboard-request");
    expect(controller).toBeDefined();
    controller?.abort();
    expect(await pending).toMatchObject({ ok: false, error: { code: "internal.cancelled" } });
    expect(mocks.readText).not.toHaveBeenCalled();
    expect(mocks.writeText).not.toHaveBeenCalled();
    expect(mocks.paste).not.toHaveBeenCalled();
    expect(mocks.availableFormats).not.toHaveBeenCalled();
    expect(mocks.readImage).not.toHaveBeenCalled();
    expect(getCancelController("clipboard-request")).toBeUndefined();
  });

  it("rejects invalid native output at the output boundary", async () => {
    mocks.readText.mockReturnValueOnce({ length: 1 });
    expect(await call(CH.terminalInput.readClipboardText)).toMatchObject({ ok: false, error: { code: "internal.contract_violation" } });
  });

  it.each([
    [CH.terminalInput.readClipboardContent, {}, mocks.readText],
    [CH.terminalInput.readClipboardText, {}, mocks.readText],
    [CH.terminalInput.writeClipboardText, { text: "hello" }, mocks.writeText],
  ])("redacts native failure for %s", async (channel, payload, operation) => {
    operation.mockImplementationOnce(() => { throw new Error("sensitive native exception"); });
    expect(await call(channel, payload)).toEqual({ ok: true, data: { kind: "refused", reason: "terminal_clipboard_unavailable" } });
    expect(mocks.log.error).not.toHaveBeenCalled();
  });
});
