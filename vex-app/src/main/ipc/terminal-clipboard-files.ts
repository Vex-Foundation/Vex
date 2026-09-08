import { app, BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { CH } from "@shared/ipc/channels.js";
import { ok, type Result } from "@shared/ipc/result.js";
import {
  readClipboardFilesInputSchema, readClipboardFilesValueSchema,
  clipboardFileReplyInputSchema, clipboardFileReplyValueSchema,
  type ReadClipboardFilesValue, type ClipboardFileReplyValue,
} from "@shared/schemas/terminal-clipboard-files.js";
import { registerHandler, type HandlerContext } from "./register-handler.js";

interface FileRequest {
  readonly window: BrowserWindow;
  readonly parentId: number;
  readonly finish: (value: ReadClipboardFilesValue) => void;
  dispatched: boolean;
}

/** Each native paste has a private decoding document, never a user-focused input. */
export function registerTerminalClipboardFileHandlers(): Array<() => void> {
  const requests = new Map<string, FileRequest>();
  const start = async (ctx: HandlerContext): Promise<Result<ReadClipboardFilesValue>> => {
    if (ctx.signal.aborted || ctx.event.sender.isDestroyed()) return ok({ kind: "cancelled" });
    if (requests.size >= 8 || [...requests.values()].some((request) => request.parentId === ctx.event.sender.id)) {
      return ok({ kind: "refused", reason: "terminal_clipboard_files_busy" });
    }
    const requestId = randomUUID();
    let window: BrowserWindow;
    try {
      window = new BrowserWindow({
        show: false, width: 100, height: 100, skipTaskbar: true,
        webPreferences: {
          preload: fileURLToPath(new URL("../preload/terminal-clipboard-files.cjs", import.meta.url)),
          contextIsolation: true, sandbox: true, nodeIntegration: false,
          nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
          allowRunningInsecureContent: false, experimentalFeatures: false,
          webSecurity: true, devTools: false, backgroundThrottling: false,
        },
      });
    } catch { return ok({ kind: "refused", reason: "terminal_clipboard_files_unavailable" }); }
    const origin = app.isPackaged || process.env["VEX_E2E_LOAD_BUILT"] === "1" ? "app://vex" : "http://127.0.0.1:5173";
    const url = `${origin}/terminal-clipboard-files.html#${requestId}`;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event, destination) => { if (destination !== url) event.preventDefault(); });
    return new Promise<Result<ReadClipboardFilesValue>>((resolve) => {
      let settled = false;
      const finish = (value: ReadClipboardFilesValue): void => {
        if (settled) return;
        settled = true;
        requests.delete(requestId);
        clearTimeout(timer);
        ctx.signal.removeEventListener("abort", cancel);
        ctx.event.sender.removeListener("destroyed", cancel);
        ctx.event.sender.removeListener("did-start-navigation", navigate);
        window.removeListener("closed", cancelled);
        if (!window.isDestroyed()) window.destroy();
        resolve(ok(value));
      };
      const cancel = (): void => finish({ kind: "cancelled" });
      const cancelled = (): void => finish({ kind: "refused", reason: "terminal_clipboard_files_unavailable" });
      const navigate = (_event: Electron.Event, _url: string, _inPlace: boolean, mainFrame: boolean): void => { if (mainFrame) cancel(); };
      const timer = setTimeout(cancelled, 5000);
      timer.unref();
      requests.set(requestId, { window, parentId: ctx.event.sender.id, finish, dispatched: false });
      ctx.signal.addEventListener("abort", cancel, { once: true });
      ctx.event.sender.once("destroyed", cancel);
      ctx.event.sender.on("did-start-navigation", navigate);
      window.once("closed", cancelled);
      void window.loadURL(url).catch(cancelled);
      if (ctx.signal.aborted || ctx.event.sender.isDestroyed()) cancel();
    });
  };
  return [
    () => { for (const request of requests.values()) request.finish({ kind: "cancelled" }); },
    registerHandler({
      channel: CH.terminalInput.readClipboardFiles, domain: "studio",
      inputSchema: readClipboardFilesInputSchema, outputSchema: readClipboardFilesValueSchema,
      handle: (_input, ctx) => start(ctx),
    }),
    registerHandler({
      channel: CH.terminalInput.clipboardFilesReply, domain: "studio",
      inputSchema: clipboardFileReplyInputSchema, outputSchema: clipboardFileReplyValueSchema,
      handle: async (input, ctx): Promise<Result<ClipboardFileReplyValue>> => {
        const request = requests.get(input.requestId);
        if (request === undefined) return ok({ kind: "refused", reason: "terminal_clipboard_request_unknown" });
        if (request.window.webContents.id !== ctx.event.sender.id) return ok({ kind: "refused", reason: "terminal_clipboard_other_window" });
        if (ctx.signal.aborted || request.window.isDestroyed()) {
          request.finish({ kind: "cancelled" });
          return ok({ kind: "refused", reason: "terminal_clipboard_request_unknown" });
        }
        if (input.kind === "ready") {
          if (request.dispatched) return ok({ kind: "refused", reason: "terminal_clipboard_already_dispatched" });
          request.dispatched = true;
          try { request.window.webContents.paste(); }
          catch { request.finish({ kind: "refused", reason: "terminal_clipboard_files_unavailable" }); }
        } else {
          if (!request.dispatched) return ok({ kind: "refused", reason: "terminal_clipboard_not_dispatched" });
          // Let the response finish crossing IPC before destroying its sender.
          queueMicrotask(() => request.finish(input.kind === "files"
            ? { kind: "files", paths: input.paths }
            : { kind: "refused", reason: "terminal_clipboard_files_unavailable" }));
        }
        return ok({ kind: "accepted" });
      },
    }),
  ];
}
