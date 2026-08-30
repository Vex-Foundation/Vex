/**
 * FILE OPEN INTENT CHANNEL - the one place the explorer parks "open this file",
 * and the one place the workspace takes it from.
 *
 * WHY A CHANNEL AND NOT A CALL. The explorer must not add a tab itself. Every
 * rule about what a tab strip may hold - dedupe on path, selection repair after
 * a close, the keep-alive bound, what is persisted - lives in
 * `workspace-model.ts` and is enforced by `StudioWorkspaceController`. A second
 * way to add a tab would be a second answer to all of those. So the tree
 * produces an ENVELOPE and the owner of those rules consumes it.
 *
 * PROJECT-KEYED. An intent names the project it was composed in, and the
 * controller dispatches it only into that project, DROPPING it otherwise: a
 * file clicked in project A must never open a tab in project B because the
 * user switched while the click was in flight.
 *
 * CONSUMED ONCE. {@link consumeFileOpenIntent} is the only read that dispatches,
 * it clears the slot in the same synchronous step, and it is keyed by
 * `intentId`. React 19's StrictMode double-invoked effect therefore finds
 * nothing on its second pass and the same file cannot be opened twice.
 *
 * This is the shape `Board/board-ask-intent.ts` uses for the identical problem
 * (a surface parks a request, the owner of the rules dispatches it), and it is
 * reused rather than re-invented so the codebase has one answer for it.
 * UI-only, NEVER persisted.
 */

import { create } from "zustand";
import type { FileNode } from "@shared/schemas/files.js";

export interface FileOpenIntent {
  /** Consume-once key. */
  readonly intentId: string;
  /** The project the file was chosen in. A mismatch drops the intent. */
  readonly projectId: string;
  /** The node as the tree held it, token included. */
  readonly node: FileNode;
}

interface FileOpenIntentState {
  /** The parked request, or null when nothing is waiting. */
  readonly intent: FileOpenIntent | null;
  /**
   * Park a file for the workspace.
   *
   * Replaces whatever was parked: a user clicking two files quickly wants the
   * second, and the first was already dispatched or already superseded.
   */
  readonly publishFileOpenIntent: (intent: FileOpenIntent) => void;
  /**
   * Take the parked file if it is THIS one and belongs to THIS project.
   *
   * Returns null - and leaves the slot alone - when the id does not match
   * (already consumed) or the project does not (a switch happened). Clearing
   * happens in the same step as the read, so there is no window in which two
   * callers both see it.
   */
  readonly consumeFileOpenIntent: (
    intentId: string,
    projectId: string,
  ) => FileOpenIntent | null;
  /** Drop the parked file without opening it. */
  readonly clearFileOpenIntent: () => void;
}

export const useFileOpenIntentStore = create<FileOpenIntentState>((set, get) => ({
  intent: null,
  publishFileOpenIntent: (intent) => {
    set({ intent });
  },
  consumeFileOpenIntent: (intentId, projectId) => {
    const current = get().intent;
    if (
      current === null ||
      current.intentId !== intentId ||
      current.projectId !== projectId
    ) {
      return null;
    }
    set({ intent: null });
    return current;
  },
  clearFileOpenIntent: () => {
    set({ intent: null });
  },
}));

/**
 * Park a file for the workspace to open. The explorer's `onOpenFile` calls this.
 *
 * Returns the intent id, so a caller that wants to cancel its own request can
 * name it rather than clearing whatever happens to be parked.
 */
export function publishFileOpen(projectId: string, node: FileNode): string {
  const intentId = nextFileOpenIntentId();
  useFileOpenIntentStore.getState().publishFileOpenIntent({ intentId, projectId, node });
  return intentId;
}

/**
 * A fresh consume-once key.
 *
 * `crypto.randomUUID` where the runtime has it (Electron's renderer and jsdom
 * both do); the counter is the last resort, and it only has to be unique within
 * one renderer's lifetime because nothing persists an intent.
 */
let intentCounter = 0;
export function nextFileOpenIntentId(): string {
  const uuid = globalThis.crypto?.randomUUID?.();
  if (typeof uuid === "string") return uuid;
  intentCounter += 1;
  return `file-open-${String(intentCounter)}`;
}
