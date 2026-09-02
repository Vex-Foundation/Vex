/**
 * THE ONE OWNER of `shell.trashItem` for the Studio project lifecycle.
 *
 * `project-delete.ts` owns the ORDER of a deletion and its durable obligation;
 * "which desktop API moves a folder to the trash" is not part of that, and
 * importing `electron` there made a module whose whole subject is Postgres and
 * the filesystem unloadable anywhere Electron is not installed - which is
 * exactly the `test:studio-postgres` lane that drives its end-to-end test.
 *
 * So the capability is injected, and this file is where it comes from. It is
 * the only place in the delete path that names `electron`, and the composition
 * roots that wire the delete (the IPC handler and the startup repair sweep)
 * import it from here rather than each reaching for `shell` themselves.
 *
 * NO GUARD LIVES HERE. The realpath-under-the-projects-root check that makes
 * trashing safe belongs to the caller that knows what the projects root is, and
 * it stays in `project-delete.ts`. This is the mechanism only.
 */

import { shell } from "electron";

/**
 * Move an absolute path to the operating system's trash.
 *
 * The TRASH, never an unlink: the user can get their files back. Rejects when
 * the platform refuses; the caller classifies that outcome.
 */
export type TrashItem = (absolutePath: string) => Promise<void>;

/** The production capability: Electron's own trash. */
export const trashItemToOsTrash: TrashItem = (absolutePath) =>
  shell.trashItem(absolutePath);
