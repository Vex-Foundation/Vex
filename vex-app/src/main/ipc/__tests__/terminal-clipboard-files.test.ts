import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@shared/ipc/channels.js";
import { createMainFrame, createTrustedSender, type TestFrame } from "./test-sender.js";

class TestContents extends EventEmitter {
  destroyed = false;
  paste = vi.fn();
  setWindowOpenHandler = vi.fn();
  constructor(readonly id: number) { super(); }
  isDestroyed(): boolean { return this.destroyed; }
}
class TestWindow extends EventEmitter {
  readonly webContents: TestContents;
  loadURL = vi.fn<(url: string) => Promise<void>>().mockResolvedValue(undefined);
  constructor(id: number) { super(); this.webContents = new TestContents(id); }
  isDestroyed(): boolean { return this.webContents.destroyed; }
  destroy = vi.fn(() => {
    if (this.isDestroyed()) return;
    this.webContents.destroyed = true;
    this.webContents.emit("destroyed");
    this.emit("closed");
  });
}
interface Sender { readonly senderFrame: TestFrame; readonly sender: TestContents }
type Handler = (event: Sender, input: unknown) => Promise<unknown>;
const mocks = vi.hoisted(() => ({
  handlers: new Map<string, Handler>(),
  packaged: true,
  createWindow: vi.fn<(options: unknown) => TestWindow>(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("electron", () => ({
  app: { get isPackaged() { return mocks.packaged; } },
  BrowserWindow: vi.fn(function (options: unknown) { return mocks.createWindow(options); }),
  ipcMain: {
    handle: (channel: string, handler: Handler) => mocks.handlers.set(channel, handler),
    removeHandler: (channel: string) => mocks.handlers.delete(channel),
  },
}));
vi.mock("../../logger/index.js", () => ({ log: mocks.log }));
const { registerTerminalClipboardFileHandlers } = await import("../terminal-clipboard-files.js");
const { getCancelController } = await import("../register-handler.js");
let disposers: Array<() => void> = [];
let counter = 0;
const decoders: TestWindow[] = [];
const nextId = (): string => `21111111-1111-4111-8111-${String(++counter).padStart(12, "0")}`;
const sender = (id = 11): Sender => createTrustedSender({ sender: new TestContents(id) });
function call(channel: string, event: Sender, payload: unknown, rpcId = nextId()): Promise<unknown> {
  const handler = mocks.handlers.get(channel);
  if (handler === undefined) throw new Error("Missing clipboard file handler");
  return handler(event, { requestId: rpcId, payload });
}
function start(event = sender()): { event: Sender; decoder: TestWindow; id: string; rpcId: string; result: Promise<unknown> } {
  const rpcId = nextId();
  const result = call(CH.terminalInput.readClipboardFiles, event, {}, rpcId);
  const decoder = decoders.at(-1);
  if (decoder === undefined) throw new Error("Expected isolated decoder");
  const url = decoder.loadURL.mock.calls[0]?.[0];
  if (url === undefined) throw new Error("Expected decoder document");
  const id = new URL(url).hash.replace(/^#/, "");
  return { event, decoder, id, rpcId, result };
}
function decoderSender(decoder: TestWindow): Sender {
  return createTrustedSender({ senderFrame: createMainFrame(decoder.loadURL.mock.calls[0]?.[0]), sender: decoder.webContents });
}
const reply = (decoder: TestWindow, payload: unknown): Promise<unknown> => call(CH.terminalInput.clipboardFilesReply, decoderSender(decoder), payload);
const refusal = (reason: string): unknown => ({ ok: true, data: { kind: "refused", reason } });
const accepted = { ok: true, data: { kind: "accepted" } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  mocks.handlers.clear();
  mocks.packaged = true;
  decoders.length = 0;
  mocks.createWindow.mockImplementation(() => {
    const decoder = new TestWindow(1000 + ++counter);
    decoders.push(decoder);
    return decoder;
  });
  disposers = registerTerminalClipboardFileHandlers();
});
afterEach(() => {
  disposers.forEach(dispose => dispose());
  vi.useRealTimers();
});

describe("isolated terminal clipboard file decoder", () => {
  it("pastes only in its private document and returns the complete decoded file list once", async () => {
    const request = start();
    expect(mocks.createWindow).toHaveBeenCalledWith(expect.objectContaining({
      show: false, skipTaskbar: true,
      webPreferences: expect.objectContaining({ contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true }),
    }));
    expect(request.decoder.loadURL).toHaveBeenCalledWith(`app://vex/terminal-clipboard-files.html#${request.id}`);
    expect(request.event.sender.paste).not.toHaveBeenCalled();
    expect(request.decoder.webContents.paste).not.toHaveBeenCalled();
    expect(await reply(request.decoder, { kind: "ready", requestId: request.id })).toEqual(accepted);
    expect(request.decoder.webContents.paste).toHaveBeenCalledExactlyOnceWith();
    const paths = ["/tmp/one file.png", "/tmp/two's file.txt"];
    expect(await reply(request.decoder, { kind: "files", requestId: request.id, paths })).toEqual(accepted);
    expect(await request.result).toEqual({ ok: true, data: { kind: "files", paths } });
    expect(request.decoder.destroy).toHaveBeenCalledOnce();
    expect(request.event.sender.listenerCount("destroyed")).toBe(0);
    expect(request.event.sender.listenerCount("did-start-navigation")).toBe(0);
    expect(await call(CH.terminalInput.clipboardFilesReply, sender(999), { kind: "files", requestId: request.id, paths }))
      .toEqual(refusal("terminal_clipboard_request_unknown"));
  });

  it("settles the owner when native paste dispatch throws, without waiting for expiry", async () => {
    const request = start();
    request.decoder.webContents.paste.mockImplementationOnce(() => { throw new Error("native unavailable"); });
    expect(await reply(request.decoder, { kind: "ready", requestId: request.id })).toEqual(accepted);
    expect(await request.result).toEqual(refusal("terminal_clipboard_files_unavailable"));
    expect(request.decoder.isDestroyed()).toBe(true);
  });

  it("loads the Vite decoder in a fresh development run without built renderer files", async () => {
    mocks.packaged = false;
    vi.stubEnv("VEX_E2E_LOAD_BUILT", "0");
    try {
      const request = start();
      expect(request.decoder.loadURL).toHaveBeenCalledWith(`http://127.0.0.1:5173/terminal-clipboard-files.html#${request.id}`);
      getCancelController(request.rpcId)?.abort();
      expect(await request.result).toEqual({ ok: true, data: { kind: "cancelled" } });
    } finally { vi.unstubAllEnvs(); }
  });

  it("rejects unknown and repeated dispatches and data before dispatch", async () => {
    expect(await call(CH.terminalInput.clipboardFilesReply, sender(), { kind: "ready", requestId: nextId() }))
      .toEqual(refusal("terminal_clipboard_request_unknown"));
    const request = start();
    expect(await reply(request.decoder, { kind: "files", requestId: request.id, paths: ["/tmp/file"] }))
      .toEqual(refusal("terminal_clipboard_not_dispatched"));
    expect(await reply(request.decoder, { kind: "ready", requestId: request.id })).toEqual(accepted);
    expect(await reply(request.decoder, { kind: "ready", requestId: request.id }))
      .toEqual(refusal("terminal_clipboard_already_dispatched"));
    expect(request.decoder.webContents.paste).toHaveBeenCalledOnce();
    expect(await reply(request.decoder, { kind: "unavailable", requestId: request.id })).toEqual(accepted);
    expect(await request.result).toEqual(refusal("terminal_clipboard_files_unavailable"));
  });

  it("refuses non-Vex senders on both channels without creating or consuming requests", async () => {
    const foreign = { ...sender(), senderFrame: createMainFrame("https://other.example") };
    expect(await call(CH.terminalInput.readClipboardFiles, foreign, {})).toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    expect(mocks.createWindow).not.toHaveBeenCalled();
    const request = start();
    expect(await call(CH.terminalInput.clipboardFilesReply, foreign, { kind: "ready", requestId: request.id }))
      .toMatchObject({ ok: false, error: { code: "validation.invalid_sender" } });
    expect(request.decoder.webContents.paste).not.toHaveBeenCalled();
    expect(await reply(request.decoder, { kind: "ready", requestId: request.id })).toEqual(accepted);
  });

  it("a trusted proposing window cannot act as its decoder", async () => {
    const request = start();
    expect(await call(CH.terminalInput.clipboardFilesReply, request.event, { kind: "ready", requestId: request.id }))
      .toEqual(refusal("terminal_clipboard_other_window"));
    expect(await call(CH.terminalInput.clipboardFilesReply, sender(22), { kind: "files", requestId: request.id, paths: ["/tmp/foreign"] }))
      .toEqual(refusal("terminal_clipboard_other_window"));
    expect(request.decoder.webContents.paste).not.toHaveBeenCalled();
  });

  it("correlates competing responses by request and decoder identity without stealing either result", async () => {
    const first = start(sender(11));
    const second = start(sender(22));
    expect(first.id).not.toBe(second.id);
    await reply(first.decoder, { kind: "ready", requestId: first.id });
    await reply(second.decoder, { kind: "ready", requestId: second.id });
    expect(await reply(second.decoder, { kind: "files", requestId: first.id, paths: ["/tmp/second"] }))
      .toEqual(refusal("terminal_clipboard_other_window"));
    expect(first.decoder.isDestroyed()).toBe(false);
    expect(second.decoder.isDestroyed()).toBe(false);
    expect(await reply(second.decoder, { kind: "files", requestId: second.id, paths: ["/tmp/second"] })).toEqual(accepted);
    expect(await second.result).toEqual({ ok: true, data: { kind: "files", paths: ["/tmp/second"] } });
    expect(first.decoder.isDestroyed()).toBe(false);
    expect(await reply(first.decoder, { kind: "files", requestId: first.id, paths: ["/tmp/first"] })).toEqual(accepted);
    expect(await first.result).toEqual({ ok: true, data: { kind: "files", paths: ["/tmp/first"] } });
  });

  it("validates strict requests and bounded decoder replies", async () => {
    expect(await call(CH.terminalInput.readClipboardFiles, sender(), { extra: true })).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(mocks.createWindow).not.toHaveBeenCalled();
    const request = start();
    for (const payload of [
      { kind: "ready", requestId: "invalid" },
      { kind: "ready", requestId: request.id, extra: true },
      { kind: "files", requestId: request.id, paths: [] },
      { kind: "files", requestId: request.id, paths: Array.from({ length: 33 }, () => "/tmp/file") },
      { kind: "files", requestId: request.id, paths: ["x".repeat(32769)] },
    ]) expect(await reply(request.decoder, payload)).toMatchObject({ ok: false, error: { code: "validation.invalid_input" } });
    expect(request.decoder.webContents.paste).not.toHaveBeenCalled();
  });

  it.each(["abort", "navigation", "destruction"])("cancels an in-flight request on parent %s and revokes late replies", async (cause) => {
    const request = start();
    await reply(request.decoder, { kind: "ready", requestId: request.id });
    if (cause === "abort") getCancelController(request.rpcId)?.abort();
    else if (cause === "navigation") request.event.sender.emit("did-start-navigation", {}, "app://vex/index.html", false, true);
    else { request.event.sender.destroyed = true; request.event.sender.emit("destroyed"); }
    expect(await request.result).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(request.decoder.isDestroyed()).toBe(true);
    expect(await call(CH.terminalInput.clipboardFilesReply, sender(), { kind: "files", requestId: request.id, paths: ["/tmp/late"] }))
      .toEqual(refusal("terminal_clipboard_request_unknown"));
    expect(request.event.sender.listenerCount("destroyed")).toBe(0);
    expect(request.event.sender.listenerCount("did-start-navigation")).toBe(0);
  });

  it("ignores subframe navigation but expires an unanswered decoder", async () => {
    const request = start();
    request.event.sender.emit("did-start-navigation", {}, "app://vex/frame.html", false, false);
    expect(request.decoder.isDestroyed()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await request.result).toEqual(refusal("terminal_clipboard_files_unavailable"));
    expect(request.decoder.isDestroyed()).toBe(true);
  });

  it.each(["closed", "load failure"])("reports decoder %s and releases the parent for a retry", async (failure) => {
    if (failure === "load failure") {
      mocks.createWindow.mockImplementationOnce(() => {
        const decoder = new TestWindow(1000 + ++counter);
        decoder.loadURL.mockRejectedValue(new Error("load rejected"));
        decoders.push(decoder);
        return decoder;
      });
    }
    const request = start();
    if (failure === "closed") request.decoder.destroy();
    expect(await request.result).toEqual(refusal("terminal_clipboard_files_unavailable"));
    const retry = start(request.event);
    expect(retry.id).not.toBe(request.id);
    getCancelController(retry.rpcId)?.abort();
    await retry.result;
  });

  it("reports construction failure without exposing the native exception", async () => {
    mocks.createWindow.mockImplementationOnce(() => { throw new Error("private native detail"); });
    expect(await call(CH.terminalInput.readClipboardFiles, sender(), {})).toEqual(refusal("terminal_clipboard_files_unavailable"));
    expect(mocks.log.error).not.toHaveBeenCalled();
    expect(decoders).toHaveLength(0);
  });

  it("does not allocate a decoder for an already destroyed parent", async () => {
    const event = sender();
    event.sender.destroyed = true;
    expect(await call(CH.terminalInput.readClipboardFiles, event, {})).toEqual({ ok: true, data: { kind: "cancelled" } });
    expect(mocks.createWindow).not.toHaveBeenCalled();
  });

  it("bounds concurrent decoders per parent and globally", async () => {
    const first = start(sender(11));
    expect(await call(CH.terminalInput.readClipboardFiles, first.event, {})).toEqual(refusal("terminal_clipboard_files_busy"));
    for (let index = 1; index < 8; index += 1) start(sender(11 + index));
    expect(decoders).toHaveLength(8);
    expect(await call(CH.terminalInput.readClipboardFiles, sender(99), {})).toEqual(refusal("terminal_clipboard_files_busy"));
    getCancelController(first.rpcId)?.abort();
    await first.result;
    start(sender(99));
    expect(decoders).toHaveLength(9);
  });
});
