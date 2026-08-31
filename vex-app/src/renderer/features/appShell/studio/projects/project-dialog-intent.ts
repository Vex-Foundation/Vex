/**
 * PROJECT DIALOG INTENT CHANNEL - the one place a surface parks "open the
 * project creator / settings / repair / delete", and the one place the dialogs
 * take it from.
 *
 * ## Why a channel and not props
 *
 * The two surfaces that raise these requests live in DIFFERENT COLUMNS of the
 * shell grid: the "+ NEW PROJECT" key and the row menu are in column 1
 * (`StudioSidebar`), the welcome CTA is in column 2 (`StudioWelcome`), and the
 * grid's only common ancestor is `AppShell` - a file that owns the frame, not
 * Studio. Threading four callbacks from there down two branches would put
 * Studio's dialog state in the frame's composition root, which rule 03 forbids
 * that root from holding.
 *
 * So a surface publishes an INTENT and the owner of the dialogs consumes it.
 * This is exactly the shape `workspace/file-open-intent.ts` and
 * `Board/board-ask-intent.ts` already use for the identical problem, reused
 * rather than re-invented so the codebase has one answer for it.
 *
 * ## The owner is `StudioProjectDialogs`, mounted by `StudioCenter`
 *
 * One consumer, and it is a component that only exists while Studio is the
 * active shell. A second consumer would mean two dialogs answering one request.
 *
 * ## Not consume-once, unlike the file-open intent
 *
 * A file-open intent is a one-shot action (open this file, once), so it is
 * taken and cleared. This is a MODE: "the settings dialog for project X is
 * open" stays true until the user closes it, which is why the request stands in
 * the store and is cleared by an explicit `close`. Publishing while one stands
 * REPLACES it, because a user who clicks Delete on a row while Settings is open
 * wants Delete.
 *
 * UI-only, process-local, NEVER persisted: this is which dialog is on screen,
 * and a dialog restored across a restart would be a modal the user never opened
 * standing over an action they never started.
 */

import { create } from "zustand";

/**
 * Which dialog is open, and about what.
 *
 * A discriminated union rather than four booleans plus a nullable id: three of
 * the four are ABOUT a project and one is not, and a shape that allowed
 * "settings open, no project" would be a state the dialog cannot render.
 */
export type ProjectDialogRequest =
  | { readonly kind: "create" }
  | { readonly kind: "settings"; readonly projectId: string }
  | { readonly kind: "repair"; readonly projectId: string }
  | { readonly kind: "delete"; readonly projectId: string };

interface ProjectDialogState {
  /** The dialog on screen, or null when none is. */
  readonly request: ProjectDialogRequest | null;
  readonly openProjectDialog: (request: ProjectDialogRequest) => void;
  readonly closeProjectDialog: () => void;
}

export const useProjectDialogStore = create<ProjectDialogState>((set) => ({
  request: null,
  openProjectDialog: (request) => {
    set({ request });
  },
  closeProjectDialog: () => {
    set({ request: null });
  },
}));

/** Open the new-project dialog. The sidebar key and the welcome CTA call this. */
export function openProjectCreator(): void {
  useProjectDialogStore.getState().openProjectDialog({ kind: "create" });
}

/** Open one project's scope editor. The row menu calls this. */
export function openProjectSettings(projectId: string): void {
  useProjectDialogStore.getState().openProjectDialog({ kind: "settings", projectId });
}

/** Open one project's repair confirmation. The row menu calls this. */
export function openProjectRepair(projectId: string): void {
  useProjectDialogStore.getState().openProjectDialog({ kind: "repair", projectId });
}

/** Open one project's delete confirmation. The row menu calls this. */
export function openProjectDelete(projectId: string): void {
  useProjectDialogStore.getState().openProjectDialog({ kind: "delete", projectId });
}

/** Close whatever is open. Idempotent. */
export function closeProjectDialog(): void {
  useProjectDialogStore.getState().closeProjectDialog();
}
