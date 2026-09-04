/**
 * FILE RENAME SIGNAL - the one place the explorer says "this file is now called
 * something else", and the one place the workspace takes it from.
 *
 * The sibling of `file-open-intent.ts`, deliberately: same shape, same reasons,
 * same folder. A surface that is not the workspace produces an ENVELOPE, and
 * the owner of the tab-strip rules consumes it. The explorer must not retarget
 * a tab itself for the reason it must not add one - every rule about what the
 * strip holds lives in `workspace-model.ts` and is enforced by
 * `StudioWorkspaceController`.
 *
 * WHY A CHANNEL AND NOT THE PATH SUBSCRIPTION. `ExplorerSession.subscribePath`
 * already exists and the file viewer uses it, but its subscriber is a TAB and a
 * tab cannot rename itself: the retarget is a change to the workspace state, so
 * its consumer has to be the one component that owns that state. Reaching that
 * component from the session would mean the controller holding an explorer
 * reference and re-subscribing on every tab change, with a mount-order race
 * (nothing re-runs the controller's effect when the tree mounts later) for no
 * gain over parking the fact where the controller already looks.
 *
 * PROJECT-KEYED and CONSUMED ONCE, exactly as the open intent is: a rename in
 * project A must never retarget a tab in project B, and React 19's StrictMode
 * double-invoked effect must not apply it twice.
 *
 * UI-only, NEVER persisted.
 */

import { create } from "zustand";
import type { FileTabTarget } from "./workspace-model.js";

export interface FileRenameSignal {
  /** Consume-once key. */
  readonly signalId: string;
  /** The project the rename happened in. A mismatch drops the signal. */
  readonly projectId: string;
  /** The project-relative path the entry had BEFORE the rename. */
  readonly fromRelativePath: string;
  /** What main confirmed the entry is now: name, path and fresh token. */
  readonly to: FileTabTarget;
}

interface FileRenameSignalState {
  /** The parked rename, or null when nothing is waiting. */
  readonly signal: FileRenameSignal | null;
  /**
   * Park a rename for the workspace.
   *
   * Replaces whatever was parked. Two renames in a row are two separate
   * writes that main has already confirmed in order, and the first was either
   * dispatched by the effect that ran between them or names a tab the second
   * does not - in which case losing it costs a stale title on a tab whose file
   * the next watcher refresh reconciles anyway. A queue here would be a second
   * ordering authority over writes main has already ordered.
   */
  readonly publishFileRenameSignal: (signal: FileRenameSignal) => void;
  /**
   * Take the parked rename if it is THIS one and belongs to THIS project.
   *
   * Returns null - and leaves the slot alone - when the id does not match
   * (already consumed) or the project does not. Clearing happens in the same
   * synchronous step as the read, so there is no window in which two mounted
   * workspaces both see it.
   */
  readonly consumeFileRenameSignal: (
    signalId: string,
    projectId: string,
  ) => FileRenameSignal | null;
  /** Drop the parked rename without applying it. */
  readonly clearFileRenameSignal: () => void;
}

export const useFileRenameSignalStore = create<FileRenameSignalState>((set, get) => ({
  signal: null,
  publishFileRenameSignal: (signal) => {
    set({ signal });
  },
  consumeFileRenameSignal: (signalId, projectId) => {
    const current = get().signal;
    if (
      current === null ||
      current.signalId !== signalId ||
      current.projectId !== projectId
    ) {
      return null;
    }
    set({ signal: null });
    return current;
  },
  clearFileRenameSignal: () => {
    set({ signal: null });
  },
}));

/**
 * Announce a confirmed rename. The explorer session's commit calls this.
 *
 * Returns the signal id, so a caller that wants to withdraw its own
 * announcement can name it rather than clearing whatever happens to be parked.
 *
 * CALLED ONLY AFTER MAIN CONFIRMS. A rename that was refused renamed nothing,
 * and a tab retargeted on an optimistic guess would point at a path that does
 * not exist.
 */
export function publishFileRename(
  projectId: string,
  fromRelativePath: string,
  to: FileTabTarget,
): string {
  const signalId = nextFileRenameSignalId();
  useFileRenameSignalStore
    .getState()
    .publishFileRenameSignal({ signalId, projectId, fromRelativePath, to });
  return signalId;
}

/**
 * A fresh consume-once key.
 *
 * `crypto.randomUUID` where the runtime has it (Electron's renderer and jsdom
 * both do); the counter is the last resort, and it only has to be unique within
 * one renderer's lifetime because nothing persists a signal.
 */
let signalCounter = 0;
export function nextFileRenameSignalId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  signalCounter += 1;
  return `file-rename-${String(signalCounter)}`;
}
