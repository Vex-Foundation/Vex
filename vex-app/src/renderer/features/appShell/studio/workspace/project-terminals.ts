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
 * NOT PERSISTED and process-local, like the registries it serves.
 */

const terminalIdsByProject = new Map<string, readonly string[]>();

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

/** Drop every entry. The window teardown path, beside the registries' own. */
export function clearProjectTerminals(): void {
  terminalIdsByProject.clear();
}
