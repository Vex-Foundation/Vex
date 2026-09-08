import { app, BrowserWindow, type WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { TerminalLinkProposal } from "@shared/schemas/terminal-links.js";
import { APP_ORIGIN } from "../protocol/app-protocol.js";

/** A separate webContents is the only authority allowed to answer this proposal. */
export function createTerminalLinkConsentWindow(parentContents: WebContents, proposal: TerminalLinkProposal): BrowserWindow {
  const parent = BrowserWindow.fromWebContents(parentContents);
  if (parent === null || parent.isDestroyed()) throw new Error("Consent parent unavailable");
  const win = new BrowserWindow({
    parent, modal: true, frame: false, show: false, width: 620, height: 720,
    minWidth: 420, minHeight: 400, resizable: true, title: "Vex link confirmation",
    webPreferences: {
      preload: path.join(path.dirname(fileURLToPath(import.meta.url)), "../preload/terminal-link-consent.cjs"),
      contextIsolation: true, sandbox: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false,
      webSecurity: true, allowRunningInsecureContent: false, experimentalFeatures: false,
      devTools: !app.isPackaged,
    },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", event => { event.preventDefault(); win.close(); });
  win.webContents.on("will-redirect", event => { event.preventDefault(); win.close(); });
  win.once("ready-to-show", () => { if (!win.isDestroyed()) { win.show(); win.focus(); } });
  win.once("closed", () => { if (!parent.isDestroyed()) { parent.focus(); parent.webContents.focus(); } });
  const origin = app.isPackaged || process.env["VEX_E2E_LOAD_BUILT"] === "1" ? APP_ORIGIN : "http://127.0.0.1:5173";
  // Fragment is display data only. Main never trusts it back and never logs it.
  void win.loadURL(`${origin}/terminal-link-consent.html#${encodeURIComponent(JSON.stringify(proposal))}`)
    .catch(() => { if (!win.isDestroyed()) win.close(); });
  return win;
}
