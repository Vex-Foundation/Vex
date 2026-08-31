/**
 * COMPOSITION for the terminal domain: the production collaborators, and the
 * process-wide instance the IPC handlers reach.
 *
 * `terminals.ts` owns the policy and takes every collaborator as a dependency,
 * which is what lets its bounds, leases and nonce behaviour be tested without
 * Electron, Postgres or a real shell. This file is the wiring, and it is the
 * only place in the domain that knows about `BrowserWindow`, the projects
 * table or the user's `$SHELL`.
 */

import { BrowserWindow } from "electron";
import { CH, EV } from "@shared/ipc/channels.js";
import type { TerminalHostAvailability } from "@shared/schemas/terminal.js";
import { getProject } from "../database/projects/read.js";
import { log } from "../logger/index.js";
import { resolveProjectDirectory, resolveProjectsRoot } from "./projects-root.js";
import { TerminalDomain } from "./terminals.js";

/**
 * The shell Vex launches.
 *
 * The user's own `$SHELL` (or `ComSpec` on Windows) with NO arguments. Not a
 * login shell: `-l` re-runs the user's login profile inside an app that already
 * inherited its environment, which duplicates PATH entries and re-prints motd
 * banners into every new terminal. VS Code's default is the same.
 *
 * The fallbacks are the POSIX and Windows guaranteed shells rather than a
 * fancier one, because a fallback that is not present turns "your shell is
 * unset" into "the terminal is broken".
 */
function resolveShell(): { executable: string; args: string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec ?? "cmd.exe", args: [] };
  }
  return { executable: process.env.SHELL ?? "/bin/sh", args: [] };
}

/**
 * A project's working directory, derived in MAIN from its slug.
 *
 * The renderer sends a project id and never a path, and `getProject` reads
 * ACTIVE projects only - so a tombstoned project resolves to `null` here and
 * its terminal is refused, without this module needing to know what a tombstone
 * is.
 */
async function resolveProjectCwd(projectId: string): Promise<string | null> {
  const correlationId = `terminal-cwd-${projectId}`;
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return null;
  const project = await getProject(projectId, correlationId);
  if (!project.ok || project.data === null) return null;
  return resolveProjectDirectory(rootOutcome.data, project.data.slug);
}

/** Broadcast to every open window. */
function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    window.webContents.send(channel, payload);
  }
}

function publishAvailability(availability: TerminalHostAvailability): void {
  broadcast(EV.terminal.availability, availability);
}

let instance: TerminalDomain | null = null;

/** The process-wide terminal domain, created on first use. */
export function terminalDomain(): TerminalDomain {
  instance ??= new TerminalDomain({
    resolveProjectCwd,
    resolveShell,
    postPort: (target, channel, payload, transfer) => {
      // `postMessage` is the only Electron API that can move a MessagePort into
      // a renderer process; `send` would structured-clone the payload and drop
      // the port silently.
      target.postMessage(channel, payload, transfer);
    },
    publishAvailability,
    publishTerminalsLost: (terminalIds) => {
      broadcast(EV.terminal.terminalsLost, { terminalIds: [...terminalIds] });
    },
  });
  return instance;
}

/**
 * Give a window's terminals up when the window goes away.
 *
 * TWO TRIGGERS, because a window can leave in two different ways and only one
 * of them is polite:
 *
 *  - `closed` on the BrowserWindow: the user closed it. Its terminals detach on
 *    the SHORT grace, so a mistaken close is recoverable for a few seconds.
 *  - `render-process-gone` on its webContents: the renderer CRASHED. The window
 *    object may still exist and may never emit `closed`, and its data-plane
 *    port is pointing at a dead process either way.
 *
 * Before this, `releaseWindow` had no production caller at all: every window
 * that closed left its port registered in the host and its terminals attached
 * to a consumer that could never come back, so they sat out the FULL detach
 * grace instead of the short one and the port stayed a live conduit into the
 * pty host with no window on the other end.
 *
 * Returns an unsubscribe for the caller that owns the window's lifetime.
 */
export function observeWindowForTerminals(window: BrowserWindow): () => void {
  const windowId = String(window.webContents.id);
  let released = false;
  const release = (reason: string): void => {
    if (released) return;
    released = true;
    log.info(`[studio:terminals] releasing window ${windowId} (${reason})`);
    void terminalDomain()
      .releaseWindow(windowId)
      .catch(() => {
        // The host may already be gone. The window is leaving regardless, and
        // its terminals are reconciled by the host-terminated path.
      });
  };

  const onClosed = (): void => {
    release("closed");
  };
  const onGone = (): void => {
    release("render-process-gone");
  };
  window.once("closed", onClosed);
  window.webContents.once("render-process-gone", onGone);

  return () => {
    window.off("closed", onClosed);
    if (!window.isDestroyed()) {
      window.webContents.off("render-process-gone", onGone);
    }
  };
}

/** Tear the domain down at app quit. Idempotent. */
export async function disposeTerminalDomain(): Promise<void> {
  const current = instance;
  instance = null;
  if (current === null) return;
  try {
    await current.dispose();
  } catch {
    log.warn("[studio:terminals] domain dispose failed; the process is quitting anyway");
  }
}

/** The channel the port transfer rides. Named here so preload and main agree. */
export const TERMINAL_PORT_CHANNEL = EV.terminal.port;

/** The control channels, re-exported so the handler module reads in one place. */
export const TERMINAL_CHANNELS = CH.terminal;
