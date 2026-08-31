/**
 * THE DELETE-PROJECT DIALOG: `SessionDeleteDialog`'s shape, widened for an
 * action that is irreversible and can move the user's folder to the trash.
 *
 * ## What it takes to arm the confirm
 *
 * A typed project name, matched against the row's own name. `expectedName`
 * travels on the input and MAIN revalidates it against the stored row, so this
 * field is not the boundary - it is the MIS-AIM boundary the schema's own note
 * names, and mis-aim is the realistic failure for an irreversible action
 * sitting in a list of similar-looking rows. The comparison here is exact:
 * trimmed of surrounding whitespace, because a trailing space from a paste is
 * not a different intent, and otherwise character for character, because a
 * case-insensitive match would arm the button for a name the user did not
 * actually read.
 *
 * ## The checkbox upgrades the whole dialog
 *
 * Unchecked, the copy states plainly that the folder stays on disk. Checked,
 * the dialog takes the warning treatment - a warning wash behind the
 * consequence, a warning hairline - because the action stopped being "Vex
 * forgets this project" and became "your files move to the trash". The
 * treatment is built from the existing state tokens rather than by adding a
 * variant to the Dialog primitive: `components/ui/dialog.tsx` has no variant
 * prop, one surface needing a warning register is not evidence that it should,
 * and a fork of the primitive would be a second dialog language.
 *
 * ## The running-terminal line comes from the RENDERER's own state
 *
 * `peekProjectTerminals` reads the index each mounted `StudioWorkspaceController`
 * publishes. It answers `null` for a project whose workspace is not mounted,
 * and the line is then OMITTED rather than printed as zero: a project the user
 * never opened in this window may well have running shells that main will
 * close, and "0 running terminals will be closed" would be an invented fact
 * about an irreversible action.
 *
 * ## All seven outcomes render distinctly
 *
 * `projectDeleteResultSchema` is a seven-member union precisely because each
 * member has a different remedy, and this dialog spends that. Two of them
 * (`removed`, `already_removed`) close and toast. `not_found` closes with its
 * own copy. The two blocked members keep the dialog open with a retry and,
 * where main sent one, the count of what was still running. `cleanup_pending`
 * keeps it open with its attempt count, and `cleanup_resumed` reports what that
 * pass did. `trash: "failed"` is reported on every member that carries it and
 * is never swallowed - the project is still deleted and the folder is still on
 * disk, and both halves are said.
 *
 * ## No auto-retry, and no "do not ask again"
 *
 * `useDeleteProject` sets `retry: false` and this dialog never resubmits on the
 * user's behalf; a retry is always a press. There is no suppression checkbox:
 * this dialog is the only thing standing between a click and an irreversible
 * action, and an option to remove it is an option to make that click free.
 *
 * Focus defaults to Cancel (rule 08: dangerous actions default to the safer
 * choice), which the disabled confirm reinforces on first open.
 */

import { useCallback, useEffect, useMemo, useState, type JSX } from "react";
import type {
  ProjectDeleteResult,
  ProjectDto,
} from "@shared/schemas/projects.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { IconWarning } from "../../../../components/icons/index.js";
import { cn } from "../../../../lib/utils.js";
import { showToast } from "../../../../lib/toast.js";
import { useDeleteProject } from "../../../../lib/api/projects.js";
import { peekProjectTerminals } from "../workspace/project-terminals.js";
import { SubmitError } from "../../SessionCreator/FormSections.js";
import { ArtifactOutcomeList } from "./RenderOutcomePanel.js";
import {
  PROJECT_CANCEL,
  PROJECT_DELETE_ATTEMPTS_NOTE,
  PROJECT_DELETE_CLEANUP_TITLE,
  PROJECT_DELETE_CONFIRM_LABEL,
  PROJECT_DELETE_CONFIRM_MISMATCH,
  PROJECT_DELETE_OUTCOME_SENTENCES,
  PROJECT_DELETE_PENDING,
  PROJECT_DELETE_RETRY,
  PROJECT_DELETE_SUBMIT,
  PROJECT_DELETE_TITLE,
  PROJECT_DELETE_TRASH_HELP,
  PROJECT_DELETE_TRASH_LABEL,
  PROJECT_TRASH_SENTENCES,
  projectDeleteActiveCallsLine,
  projectDeleteAttemptsLine,
  projectDeleteBody,
  projectDeleteConfirmPrompt,
  projectDeletedToast,
  projectDeleteTerminalsLine,
} from "./projects-copy.js";

/**
 * The outcomes that END the interaction: there is nothing left for the user to
 * decide, so the dialog closes and a toast carries the fact.
 *
 * `cleanup_pending` is deliberately NOT here even though the project is gone:
 * cleanup did not finish, retrying RESUMES it, and closing over that would hide
 * a job the user is the only one who can ask to complete.
 */
const CLOSING_OUTCOMES: ReadonlySet<ProjectDeleteResult["outcome"]> = new Set([
  "removed",
  "already_removed",
  "not_found",
]);

export interface ProjectDeleteDialogProps {
  /** `null` closes the dialog. The row as the list holds it. */
  readonly project: ProjectDto | null;
  readonly onClose: () => void;
  /**
   * The project is gone. The caller repairs its own selection and workspace
   * state; this dialog owns no shell state.
   */
  readonly onDeleted: (projectId: string) => void;
}

export function ProjectDeleteDialog({
  project,
  onClose,
  onDeleted,
}: ProjectDeleteDialogProps): JSX.Element {
  const open = project !== null;
  const deleteMutation = useDeleteProject();

  const [alsoTrashFolder, setAlsoTrashFolder] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ProjectDeleteResult | null>(null);

  // Reset on every (re)open. A checkbox or a typed name surviving from the
  // previous project would arm this dialog against a row the user has not
  // looked at.
  useEffect(() => {
    if (!open) return;
    setAlsoTrashFolder(false);
    setTypedName("");
    setSubmitError(null);
    setOutcome(null);
  }, [open, project?.id]);

  /**
   * How many terminals this project has live IN THIS WINDOW, or null when the
   * renderer does not know. Read once per opening, not per render: the count is
   * a statement about the moment the user is deciding, and a number that
   * changed under the confirmation would be a different dialog.
   */
  const liveTerminalCount = useMemo(() => {
    if (project === null) return null;
    return peekProjectTerminals(project.id)?.length ?? null;
    // `project?.id` rather than `project`: the DTO object identity changes on
    // every list refetch and would re-read a count that must not move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const nameMatches =
    project !== null && typedName.trim() === project.name;
  const pending = deleteMutation.isPending;
  const confirmDisabled = !nameMatches || pending;

  const onConfirm = useCallback(async (): Promise<void> => {
    if (project === null || !nameMatches || pending) return;
    setSubmitError(null);
    const result = await deleteMutation.mutateAsync({
      projectId: project.id,
      alsoTrashFolder,
      expectedName: project.name,
    });
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    setOutcome(result.data);
    if (CLOSING_OUTCOMES.has(result.data.outcome)) {
      // A trash that FAILED keeps the dialog open even on `removed`: the folder
      // is still on disk and that is a fact the user has to act on, not one to
      // flash past in a toast.
      const trashFailed =
        "trash" in result.data && result.data.trash === "failed";
      if (!trashFailed) {
        onDeleted(project.id);
        showToast(projectDeletedToast(project.name));
        onClose();
        return;
      }
      onDeleted(project.id);
    }
  }, [
    alsoTrashFolder,
    deleteMutation,
    nameMatches,
    onClose,
    onDeleted,
    pending,
    project,
  ]);

  const name = project?.name ?? "";
  // The warning treatment is the CHECKBOX's, not the dialog's: it appears the
  // moment the action starts touching the user's files and goes when it stops.
  const warned = alsoTrashFolder;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        className={cn("max-w-md", warned && "border-warning/40")}
        // An explicit choice, never a stray backdrop click.
        closeOnBackdropClick={false}
        data-vex-delete-warned={warned ? "true" : undefined}
      >
        <DialogHeader className="border-line-2">
          <DialogTitle>{PROJECT_DELETE_TITLE}</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            {projectDeleteBody(name)}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="gap-4">
          {liveTerminalCount !== null ? (
            <p className="flex items-start gap-1.5 text-xs text-warning">
              <IconWarning size={13} className="mt-0.5 shrink-0" />
              <span>{projectDeleteTerminalsLine(liveTerminalCount)}</span>
            </p>
          ) : null}

          <label
            className={cn(
              "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
              warned
                ? "border-warning/40 bg-warning-wash"
                : "border-line-2 hover:bg-interactive-hover",
            )}
          >
            <input
              type="checkbox"
              checked={alsoTrashFolder}
              disabled={pending}
              onChange={(event) => setAlsoTrashFolder(event.target.checked)}
              className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-warning)]"
            />
            <span className="flex flex-col gap-1">
              <span
                className={cn(
                  "text-sm",
                  warned ? "text-warning-label" : "text-ink-primary",
                )}
              >
                {PROJECT_DELETE_TRASH_LABEL}
              </span>
              <span className="text-xs text-ink-tertiary">
                {PROJECT_DELETE_TRASH_HELP}
              </span>
            </span>
          </label>

          <div className="flex flex-col gap-2">
            <Label htmlFor="vex-project-delete-confirm" className="text-xs">
              {projectDeleteConfirmPrompt(name)}
            </Label>
            <Input
              id="vex-project-delete-confirm"
              type="text"
              value={typedName}
              disabled={pending}
              autoComplete="off"
              spellCheck={false}
              aria-label={PROJECT_DELETE_CONFIRM_LABEL}
              aria-invalid={typedName.length > 0 && !nameMatches}
              onChange={(event) => setTypedName(event.target.value)}
              className="h-10"
            />
            {typedName.length > 0 && !nameMatches ? (
              <p className="text-xs text-ink-tertiary">
                {PROJECT_DELETE_CONFIRM_MISMATCH}
              </p>
            ) : null}
          </div>

          <SubmitError submitError={submitError} />

          {outcome !== null ? <DeleteOutcome outcome={outcome} /> : null}
        </DialogBody>

        <DialogFooter className="border-line-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            // The safer choice takes focus (rule 08).
            autoFocus
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            {PROJECT_CANCEL}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => void onConfirm()}
            disabled={confirmDisabled}
          >
            {pending
              ? PROJECT_DELETE_PENDING
              : outcome === null
                ? PROJECT_DELETE_SUBMIT
                : PROJECT_DELETE_RETRY}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * ONE outcome, rendered in full.
 *
 * Every branch below is keyed on the discriminant rather than on the presence
 * of a field, so a member that gains a field later cannot silently start
 * rendering under the wrong heading.
 */
function DeleteOutcome({
  outcome,
}: {
  readonly outcome: ProjectDeleteResult;
}): JSX.Element {
  return (
    <section
      role="status"
      data-vex-delete-outcome={outcome.outcome}
      className="flex flex-col gap-2 rounded-lg border border-line-2 px-3 py-2.5"
    >
      <p className="text-sm text-ink-primary">
        {PROJECT_DELETE_OUTCOME_SENTENCES[outcome.outcome]}
      </p>

      {outcome.outcome === "blocked_active_calls" ? (
        <p className="text-xs text-ink-tertiary">
          {projectDeleteActiveCallsLine(outcome.count)}
        </p>
      ) : null}

      {outcome.outcome === "cleanup_pending" ? (
        <p className="flex flex-col gap-0.5 text-xs text-ink-tertiary">
          <span>{projectDeleteAttemptsLine(outcome.attempts)}</span>
          <span>{PROJECT_DELETE_ATTEMPTS_NOTE}</span>
        </p>
      ) : null}

      {outcome.outcome === "removed" ||
      outcome.outcome === "cleanup_resumed" ||
      outcome.outcome === "cleanup_pending" ? (
        <>
          <p
            className={cn(
              "text-xs",
              outcome.trash === "failed" ? "text-warning" : "text-ink-tertiary",
            )}
            data-vex-delete-trash={outcome.trash}
          >
            {PROJECT_TRASH_SENTENCES[outcome.trash]}
          </p>
          {outcome.cleanup.length > 0 ? (
            <div className="flex flex-col gap-1.5">
              <h4 className="vex-eyebrow">{PROJECT_DELETE_CLEANUP_TITLE}</h4>
              <ArtifactOutcomeList artifacts={outcome.cleanup} />
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
