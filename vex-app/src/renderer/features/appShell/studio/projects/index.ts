/**
 * THE PUBLIC GATE of the Studio project dialogs.
 *
 * Two things leave this folder: the dialog HOST, which `StudioCenter` mounts,
 * and the INTENT publishers, which the sidebar and the welcome screen call. The
 * dialogs themselves, the fieldsets, the outcome panels, the agent catalogue
 * and the copy are implementation details, imported by their own module inside
 * this folder and by its own tests.
 *
 * The store hook is exported alongside the publishers because a test needs to
 * reset it between cases; production code has no reason to reach past a
 * publisher.
 */

export { StudioProjectDialogs } from "./StudioProjectDialogs.js";
export type { StudioProjectDialogsProps } from "./StudioProjectDialogs.js";
export {
  closeProjectDialog,
  openProjectCreator,
  openProjectDelete,
  openProjectRepair,
  openProjectSettings,
  useProjectDialogStore,
  type ProjectDialogRequest,
} from "./project-dialog-intent.js";
