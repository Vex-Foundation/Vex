/**
 * The explicit-close prompt the keep-alive bound raises.
 *
 * The bound REFUSES a fifth workspace; it never evicts one. So the user is the
 * one who decides which of the four goes, and this dialog is where they decide
 * it. Shape and posture follow `SessionDeleteDialog`: the native `<dialog>`
 * primitive for the focus trap and Escape, focus defaulting to Cancel, and NO
 * "do not ask again" - the whole point is that closing a workspace with a
 * running shell in it is a choice, and a choice that can be suppressed once and
 * applied forever is not one.
 */

import type { JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { STUDIO_WORKSPACE_KEEP_ALIVE_MAX } from "./workspace/keep-alive.js";
import {
  STUDIO_KEEP_ALIVE_CANCEL,
  STUDIO_KEEP_ALIVE_CLOSE,
  STUDIO_KEEP_ALIVE_LIST_LABEL,
  STUDIO_KEEP_ALIVE_TITLE,
  studioKeepAliveCloseLabel,
  studioKeepAliveDescription,
} from "./studio-copy.js";

export interface StudioKeepAliveDialogProps {
  /** The project that could not be opened, or null while the dialog is closed. */
  readonly requestedProject: ProjectDto | null;
  /** The mounted workspaces, in the order the keep-alive set holds them. */
  readonly openProjects: readonly ProjectDto[];
  readonly onCancel: () => void;
  readonly onCloseWorkspace: (projectId: string) => void;
}

export function StudioKeepAliveDialog({
  requestedProject,
  openProjects,
  onCancel,
  onCloseWorkspace,
}: StudioKeepAliveDialogProps): JSX.Element {
  const open = requestedProject !== null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      <DialogContent className="max-w-md">
        <DialogHeader className="border-line-2">
          <DialogTitle>{STUDIO_KEEP_ALIVE_TITLE}</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            {requestedProject === null
              ? ""
              : studioKeepAliveDescription(
                  requestedProject.name,
                  STUDIO_WORKSPACE_KEEP_ALIVE_MAX,
                )}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="gap-2">
          <ul aria-label={STUDIO_KEEP_ALIVE_LIST_LABEL} className="flex flex-col gap-1">
            {openProjects.map((project) => (
              <li
                key={project.id}
                className="flex h-9 items-center gap-2 rounded-lg px-2"
              >
                <span className="min-w-0 flex-1 truncate text-[14px] leading-[20px] text-ink-primary">
                  {project.name}
                </span>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  aria-label={studioKeepAliveCloseLabel(project.name)}
                  onClick={() => onCloseWorkspace(project.id)}
                >
                  {STUDIO_KEEP_ALIVE_CLOSE}
                </Button>
              </li>
            ))}
          </ul>
        </DialogBody>

        <DialogFooter className="border-line-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            autoFocus
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            {STUDIO_KEEP_ALIVE_CANCEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
