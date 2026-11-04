/**
 * WHICH PROJECTS HAVE A LIVE SHELL, as the mounted workspaces know it: the
 * fact behind the sidebar's RUNNING tag (our approved Studio plate,
 * docs/design/H3-DESKTOP.md section 4.9).
 *
 * A MIRROR, never a second source. Each `StudioWorkspaceController` decides
 * from its own state whether any of its terminals is still live (the same
 * `terminalGroupIsLive` its tab squares read: not exited, not lost with the
 * host) and publishes that one boolean here while it is mounted; it clears
 * the entry when it unmounts, which is when the user closed the workspace
 * and its shells were ended. A project whose workspace is not mounted has
 * no entry, and the sidebar then draws no tag: the renderer does not know
 * whether a shell runs there, and the tag never claims what nobody checked.
 *
 * Subscribable for `useSyncExternalStore`; process-local and not persisted,
 * like the workspace handles beside it.
 */

import { useCallback, useSyncExternalStore } from "react";

const liveByProject = new Map<string, boolean>();
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** The controller's publish: whether this project has a live shell now. */
export function publishProjectLive(projectId: string, live: boolean): void {
  if (liveByProject.get(projectId) === live) return;
  liveByProject.set(projectId, live);
  notify();
}

/** The controller's unmount: the workspace is gone, so nothing is known. */
export function clearProjectLive(projectId: string): void {
  if (!liveByProject.delete(projectId)) return;
  notify();
}

/** Whether this project's mounted workspace has a live shell. False when none is mounted. */
export function peekProjectLive(projectId: string): boolean {
  return liveByProject.get(projectId) === true;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The RUNNING tag's reader. */
export function useProjectLive(projectId: string): boolean {
  const snapshot = useCallback(() => peekProjectLive(projectId), [projectId]);
  return useSyncExternalStore(subscribe, snapshot, () => false);
}

/** Drop every entry: the window teardown, and a test's reset. */
export function clearAllProjectLive(): void {
  if (liveByProject.size === 0) return;
  liveByProject.clear();
  notify();
}
