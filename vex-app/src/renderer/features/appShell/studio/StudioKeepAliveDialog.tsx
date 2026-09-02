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
 *
 * It is also the CONFIRMATION for a destructive act, and says so per row. A
 * close ends that project's shells (VS Code's close semantics: the buffers
 * revive on reopen, the processes do not), so each row carries the number it
 * would end. That is `confirmOnExit`'s job here, and it is why the dialog kept
 * its focus on Cancel.
 */

import { useMemo, type JSX } from "react";
import type { ProjectDto } from "@shared/schemas/projects.js";
import { Button } from "../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { DIALOG_INITIAL_FOCUS } from "./projects/dialog-initial-focus.js";
import {
  PROJECT_CLOSE_CONSEQUENCE_SCOPE,
  PROJECT_CLOSE_CONSEQUENCE_UNDO,
  PROJECT_CLOSE_CONSEQUENCE_WHAT,
} from "./projects/projects-copy.js";
import { STUDIO_WORKSPACE_KEEP_ALIVE_MAX } from "./workspace/keep-alive.js";
import { peekProjectTerminals } from "./workspace/project-terminals.js";
import {
  STUDIO_KEEP_ALIVE_CANCEL,
  STUDIO_KEEP_ALIVE_CLOSE,
  STUDIO_KEEP_ALIVE_LIST_LABEL,
  STUDIO_KEEP_ALIVE_TITLE,
  studioKeepAliveCloseLabel,
  studioKeepAliveDescription,
  studioKeepAliveTerminalsLine,
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

  /**
   * How many shells each row would end, read ONCE PER OPENING.
   *
   * The same rule the delete dialog states: a count that moved under the
   * confirmation would be a different dialog from the one the user read. So the
   * memo is keyed on `open` and on the row ids, never on the DTO identities,
   * which change on every list refetch.
   */
  const rowIds = openProjects.map((project) => project.id).join("\u0000");
  const terminalCounts = useMemo(() => {
    const counts = new Map<string, number | null>();
    if (!open) return counts;
    for (const id of rowIds === "" ? [] : rowIds.split("\u0000")) {
      counts.set(id, peekProjectTerminals(id)?.length ?? null);
    }
    return counts;
  }, [open, rowIds]);

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

        {/* THE CONSEQUENCE. This dialog holds N buttons, each of which ends
          * running shells, and the fact that any of them do was carried only by
          * the per-row terminal count - which is omitted, never guessed, for a
          * project whose workspace this window cannot see. The strip states the
          * consequence once, above the rows, so it holds for every button in
          * the list including the ones with no count beside them. */}
        <DialogConsequence data-vex-consent="close-workspace">
          <span className="font-medium">{PROJECT_CLOSE_CONSEQUENCE_WHAT}</span>
          <span className="text-ink-secondary">
            {PROJECT_CLOSE_CONSEQUENCE_SCOPE}
          </span>
          <span className="text-ink-secondary">
            {PROJECT_CLOSE_CONSEQUENCE_UNDO}
          </span>
        </DialogConsequence>

        <DialogBody className="gap-2">
          <ul aria-label={STUDIO_KEEP_ALIVE_LIST_LABEL} className="flex flex-col gap-1">
            {openProjects.map((project) => (
              <li
                key={project.id}
                className="flex min-h-9 items-center gap-2 rounded-lg px-2 py-1"
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="truncate text-[14px] leading-[20px] text-ink-primary">
                    {project.name}
                  </span>
                  {/* Omitted, never guessed, when no workspace published a
                    * count: printing "0" for a project whose terminals the
                    * renderer cannot see would be an invented fact about an
                    * action that ends running shells. */}
                  {(() => {
                    const count = terminalCounts.get(project.id);
                    return count === null || count === undefined ? null : (
                      <span className="truncate text-[12px] leading-4 text-ink-secondary">
                        {studioKeepAliveTerminalsLine(count)}
                      </span>
                    );
                  })()}
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
            // The safer choice takes focus (rule 08). The ATTRIBUTE is what
            // survives `showModal()`: without it a browser focuses the first
            // focusable descendant, which here is the first project's `Close`
            // button - a control that ends every shell running in that project.
            // See `DIALOG_INITIAL_FOCUS`.
            autoFocus
            {...DIALOG_INITIAL_FOCUS}
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            {STUDIO_KEEP_ALIVE_CANCEL}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
