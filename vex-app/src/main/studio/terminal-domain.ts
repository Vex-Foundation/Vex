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
import { resolveShellLaunch } from "./shell-catalogue.js";
import { TerminalDomain, type ProjectActivation } from "./terminals.js";

/**
 * A project's working directory AND its on-screen name, derived in MAIN.
 *
 * The renderer sends a project id and never a path, and `getProject` reads
 * ACTIVE projects only - so a tombstoned project resolves to `null` here and
 * its terminal is refused, without this module needing to know what a tombstone
 * is.
 *
 * BOTH FACTS COME FROM ONE READ, deliberately. The directory is where the pty
 * spawns; the label is what the pty host renders when the shell sits at that
 * directory (`pty-host/display-cwd.ts` owns the rendering, main owns the name).
 * Reading them separately would let a rename land between the two and produce a
 * terminal whose header names a different project than the one it runs in.
 *
 * The label is the project's SLUG - the same name the projects list and the
 * explorer already show. It is display text: no handler accepts it back.
 */
async function resolveProjectLocation(
  projectId: string,
): Promise<{ directory: string; label: string } | null> {
  const correlationId = `terminal-cwd-${projectId}`;
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return null;
  const project = await getProject(projectId, correlationId);
  if (!project.ok || project.data === null) return null;
  const directory = resolveProjectDirectory(rootOutcome.data, project.data.slug);
  if (directory === null) return null;
  return { directory, label: project.data.slug };
}

/**
 * The DATABASE's answer about a project id, for the commit path.
 *
 * `getProject` is the repository's ACTIVE-ONLY read - `deleted_at IS NULL` in
 * the statement - and it is the same read the rest of this file already trusts
 * for `resolveProjectLocation`. It answers `ok(null)` for a tombstone and for an id
 * that names nothing alike, which is exactly the `absent` this domain refuses
 * on. A failed read is never `absent`: it becomes `unreadable`, and the domain
 * fails closed on it rather than treating an unreachable database as consent.
 */
async function readProjectActivation(projectId: string): Promise<ProjectActivation> {
  const project = await getProject(projectId, `terminal-activation-${projectId}`);
  if (!project.ok) return "unreadable";
  return project.data === null ? "absent" : "active";
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
    resolveProjectLocation,
    readProjectActivation,
    resolveShellLaunch: (shellId) => resolveShellLaunch(shellId),
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
