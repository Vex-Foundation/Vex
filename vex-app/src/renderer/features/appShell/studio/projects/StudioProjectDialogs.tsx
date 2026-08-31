/**
 * THE ONE OWNER of Studio's project dialogs.
 *
 * It consumes `project-dialog-intent.ts` and mounts whichever dialog the
 * standing request names. Every surface that can raise one of these - the
 * sidebar's "+ NEW PROJECT" key, the row menu, the welcome CTA - publishes an
 * intent; nothing else mounts a dialog.
 *
 * Mounted by `StudioCenter`, which is the composition point that exists exactly
 * as long as Studio is the active shell. Not by `AppShell`: that file owns the
 * three-column frame, and Studio's dialog state is not the frame's business
 * (rule 03 - a composition root wires, it does not hold another feature's
 * policy). The dialogs are native `<dialog>` elements in the browser's top
 * layer, so which column mounts them has no effect on where they paint.
 *
 * ## Only the open dialog is mounted
 *
 * Each branch is conditional rather than always-mounted-with-`open={false}`,
 * because these dialogs run real queries: the settings editor reads a project,
 * the creator reads the wallet inventory. Four permanently mounted dialogs
 * would put four idle subscriptions behind every Studio session that never
 * opens one.
 *
 * ## The project row comes from the LIST, not a second read
 *
 * The delete and repair dialogs need a `ProjectDto` and the list already holds
 * one for every row. Reading it here keeps `useProjects` the single source for
 * "what projects exist" - the settings editor is the only surface that reads a
 * project on its own, because it is the only one that needs the exact
 * `scopeVersion` it will submit against.
 *
 * A request naming a project the list no longer carries CLOSES itself rather
 * than rendering an empty dialog: the row is gone, so the action is gone.
 */

import { useEffect, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { useProjects } from "../../../../lib/api/projects.js";
import { ProjectCreator } from "./ProjectCreator.js";
import { ProjectDeleteDialog } from "./ProjectDeleteDialog.js";
import { ProjectRepairDialog } from "./ProjectRepairDialog.js";
import { ProjectSettingsDialog } from "./ProjectSettingsDialog.js";
import {
  closeProjectDialog,
  useProjectDialogStore,
} from "./project-dialog-intent.js";

export interface StudioProjectDialogsProps {
  /** Select the project a create just produced. */
  readonly onProjectCreated: (project: ProjectDto) => void;
  /**
   * A project was deleted. The centre repairs its keep-alive set and its
   * selection; this component owns no shell state.
   */
  readonly onProjectDeleted: (projectId: string) => void;
}

export function StudioProjectDialogs({
  onProjectCreated,
  onProjectDeleted,
}: StudioProjectDialogsProps): JSX.Element | null {
  const request = useProjectDialogStore((s) => s.request);
  const query = useProjects();
  const projects: readonly ProjectDto[] =
    query.data !== undefined && query.data.ok ? query.data.data : [];

  const targetId = request !== null && request.kind !== "create" ? request.projectId : null;
  const target =
    targetId === null
      ? null
      : (projects.find((project) => project.id === targetId) ?? null);

  /**
   * Close a request whose project has gone, but only against a SETTLED list.
   *
   * The guard is the same one `StudioCenter`'s stale-selection repair uses and
   * exists for the same reason: reconciling against a loading or failed read
   * would slam the dialog shut the moment a refetch blipped, in the middle of
   * someone typing a project name to confirm a delete.
   */
  const listSettled = query.isSuccess && query.data.ok;
  useEffect(() => {
    if (!listSettled || targetId === null || target !== null) return;
    closeProjectDialog();
  }, [listSettled, target, targetId]);

  if (request === null) return null;

  if (request.kind === "create") {
    return (
      <ProjectCreator
        open
        onOpenChange={(next) => {
          if (!next) closeProjectDialog();
        }}
        onCreated={onProjectCreated}
      />
    );
  }

  if (request.kind === "settings") {
    return (
      <ProjectSettingsDialog
        projectId={request.projectId}
        onClose={closeProjectDialog}
      />
    );
  }

  if (request.kind === "repair") {
    return <ProjectRepairDialog project={target} onClose={closeProjectDialog} />;
  }

  return (
    <ProjectDeleteDialog
      project={target}
      onClose={closeProjectDialog}
      onDeleted={onProjectDeleted}
    />
  );
}
