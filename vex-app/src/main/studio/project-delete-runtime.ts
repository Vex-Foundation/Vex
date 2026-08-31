/**
 * The DESKTOP-RUNTIME collaborators a project delete needs, bound once.
 *
 * `project-delete.ts` is deliberately free of `electron`: its logic is a
 * database-plus-filesystem path that its integration suite can drive without a
 * desktop runtime at all. The two capabilities it cannot provide for itself -
 * moving a folder to the OS trash, and locating `userData` to delete the
 * project's terminal snapshot - are injected.
 *
 * They are bound HERE, in one place, rather than at each call site. There are
 * two production callers (the delete IPC handler and the startup repair of
 * unfinished cleanups), and a second literal is how one of them ends up
 * missing a capability the other has - which for the snapshot would mean a
 * repaired cleanup that silently leaves a deleted project's terminal output on
 * disk.
 */

import { removeTerminalSnapshot } from "./pty-host-starter.js";
import { trashItemToOsTrash } from "./os-trash.js";
import type { ProjectDeleteDeps } from "./project-delete.js";

export const projectDeleteRuntimeDeps: ProjectDeleteDeps = {
  trashItem: trashItemToOsTrash,
  removeTerminalSnapshot,
};
