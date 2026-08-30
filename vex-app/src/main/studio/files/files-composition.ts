/**
 * COMPOSITION for the files domain: the production collaborators, and the
 * process-wide instance the IPC handlers reach.
 *
 * `files-domain.ts` owns the policy and takes every collaborator as a
 * dependency, which is what lets its leases, refcounts, fan-out and teardown
 * ordering be tested without Electron, Postgres or a native watcher. This file
 * is the wiring, and it is the only place in the domain that knows about
 * `BrowserWindow`, the `projects` table or @parcel/watcher.
 *
 * The same shape `terminal-domain.ts` uses, for the same reason.
 */

import { BrowserWindow } from "electron";

import { EV } from "@shared/ipc/channels.js";
import type { FilesEvent } from "@shared/schemas/files.js";

import { getProject } from "../../database/projects/read.js";
import { log } from "../../logger/index.js";
import { resolveProjectDirectory, resolveProjectsRoot } from "../projects-root.js";
import { FilesDomain } from "./files-domain.js";
import {
  pollForRootReturn,
  projectRootExists,
  subscribeNativeWatcher,
} from "./native-adapters.js";

/**
 * A project's directory, derived in MAIN from its slug.
 *
 * The renderer sends a project id and never a path, and `getProject` reads
 * ACTIVE projects only - so a tombstoned project resolves to `null` here and
 * every read of it is refused, without this module needing to know what a
 * tombstone is. Identical to `terminal-domain.ts`'s cwd resolution, and
 * deliberately so: two different answers to "where does this project live"
 * would be two sources of truth.
 */
async function resolveFilesProjectDirectory(projectId: string): Promise<string | null> {
  const correlationId = `files-dir-${projectId}`;
  const rootOutcome = await resolveProjectsRoot(correlationId);
  if (!rootOutcome.ok) return null;
  const project = await getProject(projectId, correlationId);
  if (!project.ok || project.data === null) return null;
  return resolveProjectDirectory(rootOutcome.data, project.data.slug);
}

/** Send one event to one window, by its `webContents` id. */
function publish(windowId: string, event: FilesEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (window.isDestroyed()) continue;
    if (String(window.webContents.id) !== windowId) continue;
    window.webContents.send(EV.files.changed, event);
    return;
  }
}

let instance: FilesDomain | null = null;

/** The process-wide files domain, created on first use. */
export function filesDomain(): FilesDomain {
  instance ??= new FilesDomain({
    resolveProjectDirectory: resolveFilesProjectDirectory,
    subscribeNative: subscribeNativeWatcher,
    pollForRoot: pollForRootReturn,
    rootExists: projectRootExists,
    publish,
  });
  return instance;
}

/**
 * Give a window's file subscriptions up when the window goes away.
 *
 * TWO TRIGGERS, for the same reason `observeWindowForTerminals` has two: a
 * closed window emits `closed`, while a CRASHED renderer may only ever emit
 * `render-process-gone` - and a subscription whose window is dead is a native
 * OS watch being held for nobody.
 *
 * Returns an unsubscribe for the caller that owns the window's lifetime.
 */
export function observeWindowForFiles(window: BrowserWindow): () => void {
  const windowId = String(window.webContents.id);
  let released = false;
  const release = (reason: string): void => {
    if (released) return;
    released = true;
    log.info(`[studio:files] releasing window ${windowId} (${reason})`);
    void filesDomain()
      .releaseWindow(windowId)
      .catch(() => {
        // The window is leaving regardless; a failed release leaves a watcher
        // that app shutdown disposes.
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
export async function disposeFilesDomain(): Promise<void> {
  const current = instance;
  instance = null;
  if (current === null) return;
  try {
    await current.dispose();
  } catch {
    log.warn("[studio:files] domain dispose failed; the process is quitting anyway");
  }
}
