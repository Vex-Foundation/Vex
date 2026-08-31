/**
 * WHICH TERMINALS BELONG TO WHICH PROJECT - a derived index, outside React.
 *
 * `TerminalRegistry` is keyed by terminal id alone and knows nothing about
 * projects, which is correct: it owns xterm instances, not product structure.
 * The project association lives in each `StudioWorkspaceController`'s state,
 * and that state unmounts with the controller.
 *
 * That leaves one operation with no way to do its job: the Studio centre
 * CLOSING a kept-alive workspace. The controller's unmount deliberately does
 * not dispose anything (see its teardown effect - the attachments belong to the
 * hosts, and the shells survive to be reattached), so a workspace that the user
 * explicitly closed would leave its xterm instances, their buffers, their theme
 * observers and their WebGL contexts retained for the life of the window, named
 * by nothing that is still mounted.
 *
 * So the controller PUBLISHES its terminal ids here while it is mounted, and
 * the centre TAKES them when the user closes that workspace. It is an index,
 * not a second source of truth: the controller's workspace state remains the
 * only thing that decides which terminals a project has, and this module only
 * ever mirrors it.
 *
 * ## The workspace LIFECYCLE travels the same way, and for the same reason
 *
 * B4b-C made an explicit close kill the project's ptys, which turned the close
 * into an ORDERED operation: the buffer-bearing snapshot must be committed
 * while every shell is still alive, and only then may they be killed. Both
 * halves need the workspace LAYOUT, which lives in the controller's state - and
 * the centre, which is where the user's close gesture lands, does not have it.
 *
 * So the controller also publishes a {@link ProjectWorkspaceLifecycle} here and
 * the centre CALLS it. The ordering therefore lives with the state it orders,
 * and the centre keeps the one decision that is genuinely its own: when a
 * workspace leaves the set.
 *
 * ## Two operations on one handle, not two registries
 *
 * `close` and `discard` are the same owner answering the same question - what
 * happens to this workspace's unsaved layout - with opposite answers, and the
 * controller publishes them in one effect from one closure. A second map would
 * make each publisher responsible for not clobbering the other's half for no
 * gain, which is precisely the lost update the terminal-id index is kept
 * separate to avoid (that one IS published by a different effect on different
 * dependencies).
 *
 * NOT PERSISTED and process-local, like the registries it serves.
 */

import type { WorkspaceCloseOutcome } from "./close-lifecycle.js";

const terminalIdsByProject = new Map<string, readonly string[]>();

/**
 * What a mounted workspace can be asked to do about its unsaved layout.
 *
 * Both members are owned by the `StudioWorkspaceController` for this project
 * and both go through its close-lifecycle state machine, so a caller cannot put
 * the workspace into an inconsistent phase by choosing the wrong one.
 */
export interface ProjectWorkspaceLifecycle {
  /**
   * CLOSE: commit the buffer-bearing snapshot, then end the shells.
   *
   * SINGLE-FLIGHT. A second call while the first is running joins it and
   * resolves with the same outcome; it never starts a second commit and never
   * returns before the first has finished. The caller must act on the outcome:
   * a failed close has destroyed nothing and its workspace must stay mounted.
   */
  readonly close: () => Promise<WorkspaceCloseOutcome>;
  /**
   * DISCARD: this project has been DELETED, so nothing here may ever be
   * written again.
   *
   * Synchronous by contract, because the only correct moment to call it is
   * BEFORE the controller unmounts - the unmount flush is one of the writers it
   * exists to stop, and an async latch would land after it.
   *
   * Kills nothing: the delete's own close hook in main has already ended the
   * project's shells under authority this renderer does not have.
   */
  readonly discard: () => void;
}

/** Each mounted workspace's lifecycle handle, keyed by project. */
const lifecycleByProject = new Map<string, ProjectWorkspaceLifecycle>();

/**
 * Mirror one project's terminal ids. Called by the controller that owns them.
 *
 * Replaces the whole entry: the caller always publishes the complete set, so a
 * merge would keep ids the workspace has already closed.
 */
export function publishProjectTerminals(
  projectId: string,
  terminalIds: readonly string[],
): void {
  terminalIdsByProject.set(projectId, [...terminalIds]);
}

/**
 * Read one project's terminal ids WITHOUT taking them, or `null` when this
 * project has published nothing.
 *
 * The distinction between `null` and `[]` is the whole point and the reason
 * this is not `takeProjectTerminals().length`. Only a MOUNTED workspace
 * publishes, so `null` means "this project's workspace is not mounted, so the
 * renderer does not know how many terminals it has" while `[]` means "it is
 * mounted and it has none". The delete dialog says "N running terminals will
 * be closed" from the second and stays SILENT on the first: a project whose
 * workspace was never opened in this window may well have running shells that
 * main will close, and printing "0" there would be an invented fact about an
 * irreversible action.
 *
 * Non-destructive, unlike {@link takeProjectTerminals}: a reader is not a
 * disposer, and a dialog that consumed the index would leave the centre with
 * nothing to dispose when the workspace actually closed.
 */
export function peekProjectTerminals(
  projectId: string,
): readonly string[] | null {
  return terminalIdsByProject.get(projectId) ?? null;
}

/**
 * Read AND FORGET one project's terminal ids.
 *
 * Take-once because the caller is about to dispose them: leaving the entry
 * behind would let a second close dispose ids that no longer exist, and the
 * registry's `dispose` is only idempotent because it tolerates a missing
 * record, which is not a guarantee to lean on twice.
 */
export function takeProjectTerminals(projectId: string): readonly string[] {
  const ids = terminalIdsByProject.get(projectId) ?? [];
  terminalIdsByProject.delete(projectId);
  return ids;
}

/**
 * Register this project's lifecycle handle. Returns the unregister.
 *
 * Identity-checked on the way out, like every other single-slot registration in
 * this feature: a controller that unmounted AFTER its successor mounted must
 * not delete the successor's handle.
 */
export function publishProjectWorkspaceLifecycle(
  projectId: string,
  lifecycle: ProjectWorkspaceLifecycle,
): () => void {
  lifecycleByProject.set(projectId, lifecycle);
  return () => {
    if (lifecycleByProject.get(projectId) === lifecycle) {
      lifecycleByProject.delete(projectId);
    }
  };
}

/**
 * Read this project's lifecycle handle WITHOUT taking it, or `null` when no
 * workspace is mounted for it.
 *
 * NON-DESTRUCTIVE, and the change is load-bearing. This used to be a take-once
 * read, and the take-once WAS the concurrency control: a second close gesture
 * arriving while the first was still persisting found `null`, concluded there
 * was no workspace, and unmounted the controller mid-commit - destroying the
 * only owner of the layout being written. Concurrency is now owned where the
 * in-flight work is, by the controller's single-flight close, so a second
 * caller gets the SAME handle and joins the SAME completion.
 *
 * It also has to survive a failed close. A close that refused leaves its
 * workspace mounted and retryable, and a registry that had already forgotten
 * its handle would leave the retry with nothing to call.
 */
export function peekProjectWorkspaceLifecycle(
  projectId: string,
): ProjectWorkspaceLifecycle | null {
  return lifecycleByProject.get(projectId) ?? null;
}

/** Drop every entry. The window teardown path, beside the registries' own. */
export function clearProjectTerminals(): void {
  terminalIdsByProject.clear();
  lifecycleByProject.clear();
}
