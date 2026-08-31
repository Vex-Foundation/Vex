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
 * ## The CLOSE HANDLER travels the same way, and for the same reason
 *
 * B4b-C made an explicit close kill the project's ptys, which turned the close
 * into an ORDERED operation: the buffer-bearing snapshot must be committed
 * while every shell is still alive, and only then may they be killed. Both
 * halves need the workspace LAYOUT, which lives in the controller's state - and
 * the centre, which is where the user's close gesture lands, does not have it.
 *
 * So the controller also publishes a `close` handler here, and the centre TAKES
 * it and awaits it before removing the project from the kept-alive set. The
 * ordering therefore lives with the state it orders, and the centre keeps the
 * one decision that is genuinely its own: when a workspace leaves the set.
 *
 * NOT PERSISTED and process-local, like the registries it serves.
 */

const terminalIdsByProject = new Map<string, readonly string[]>();

/**
 * Each mounted workspace's ordered close, keyed by project.
 *
 * A SECOND map rather than a field beside the terminal ids, because the two are
 * published by different effects on different dependencies: merging them would
 * make each publisher responsible for preserving the other's half, which is a
 * lost-update waiting to happen for no gain.
 */
const closeByProject = new Map<string, () => Promise<void>>();

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
 * Register this project's ordered close. Returns the unregister.
 *
 * Identity-checked on the way out, like every other single-slot registration in
 * this feature: a controller that unmounted AFTER its successor mounted must
 * not delete the successor's handler.
 */
export function publishProjectWorkspaceClose(
  projectId: string,
  close: () => Promise<void>,
): () => void {
  closeByProject.set(projectId, close);
  return () => {
    if (closeByProject.get(projectId) === close) closeByProject.delete(projectId);
  };
}

/**
 * Read AND FORGET this project's ordered close, or `null` when no workspace is
 * mounted for it.
 *
 * TAKE-ONCE, and that is the whole concurrency control on the close path: a
 * second close gesture arriving while the first is still persisting and killing
 * gets `null` and does nothing, rather than committing a second snapshot and
 * killing terminals the first close has already ended.
 */
export function takeProjectWorkspaceClose(
  projectId: string,
): (() => Promise<void>) | null {
  const close = closeByProject.get(projectId) ?? null;
  closeByProject.delete(projectId);
  return close;
}

/** Drop every entry. The window teardown path, beside the registries' own. */
export function clearProjectTerminals(): void {
  terminalIdsByProject.clear();
  closeByProject.clear();
}
