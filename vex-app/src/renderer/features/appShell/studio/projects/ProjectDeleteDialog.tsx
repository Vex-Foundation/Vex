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
 * (`removed`, `already_removed`) close and toast. The two blocked members keep
 * the dialog open with a retry and, where main sent one, the count of what was
 * still running. `cleanup_pending` keeps it open with its attempt count, and
 * `cleanup_resumed` reports what that pass did. `trash: "failed"` is reported on
 * every member that carries it and is never swallowed - the project is still
 * deleted and the folder is still on disk, and both halves are said.
 *
 * ## `not_found` is NOT a delete, and this dialog stopped claiming it was
 *
 * Main answers `not_found` for a project it cannot find AND for one whose
 * stored name did not match the `expectedName` this dialog sent - a concurrent
 * rename of a project that is still there. Reporting it as a delete closed a
 * possibly live workspace, cleared the selection for a project that still
 * exists, and toasted `Deleted "name"` about a row nothing happened to. So it
 * keeps the dialog open on its own uncertain pane, tells the shell nothing, and
 * toasts nothing. The reconciliation is the LIST: `useDeleteProject`
 * invalidates it on this Result like any other, and the host then closes the
 * dialog if the project really is gone, or leaves it standing under the fresh
 * name if it was renamed.
 *
 * ## The row is PINNED once an outcome leaves the dialog open
 *
 * `cleanup_pending`, `cleanup_resumed` and a `removed` whose trash failed all
 * report on a project that is already tombstoned, so the invalidated list drops
 * it and the host's settled-list guard would close this dialog over the retry
 * the user is the only one who can press. The row this dialog SUBMITTED
 * AGAINST is therefore pinned at that moment and the dialog goes on rendering
 * from the pin, while `onHoldOpen` tells the host to hold the request open.
 * `not_found` is the one open outcome that is deliberately not pinned: its
 * whole remedy is the reloaded list, so a project that really is gone should
 * take the dialog with it.
 *
 * ## The folder choice FREEZES once the delete is durable
 *
 * Main writes the trash intent onto the TOMBSTONE, and a retry resumes that
 * recorded request while ignoring the input the retry itself carries
 * (`main/studio/project-delete.ts`, the `already_tombstoned` branch). So from
 * the outcome that proves the tombstone exists, this dialog remembers the value
 * it SUBMITTED - which is by definition the value the tombstone recorded,
 * because that attempt is the one that created it - shows that value, freezes
 * the checkbox, and sends the remembered value on every retry. Leaving the
 * checkbox live would let a user uncheck it and watch the folder go to the
 * trash anyway, or check it and watch the folder stay: a destructive choice the
 * UI reported and the system did not honour.
 *
 * The freeze cannot outlive the dialog, and does not need to. A tombstoned row
 * is `deleted_at IS NOT NULL`, `listProjects` reads `WHERE deleted_at IS NULL`
 * (`main/database/projects/read.ts`), and this dialog's row comes only from
 * that list through `StudioProjectDialogs` - so no delete dialog can ever be
 * opened again on a project whose cleanup is still pending, and there is no
 * reopened-after-restart case for the memory to miss.
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
  PROJECT_DELETE_TRASH_LOCKED_NOTE,
  PROJECT_TRASH_SENTENCES,
  projectDeleteActiveCallsLine,
  projectDeleteAttemptsLine,
  projectDeleteBody,
  projectDeleteConfirmPrompt,
  projectDeletedToast,
  projectDeleteTerminalsLine,
} from "./projects-copy.js";

/**
 * The outcomes that END the interaction: the project is gone, Vex is certain of
 * it, and there is nothing left for the user to decide - so the dialog closes
 * and a toast carries the fact.
 *
 * `cleanup_pending` is deliberately NOT here even though the project is gone:
 * cleanup did not finish, retrying RESUMES it, and closing over that would hide
 * a job the user is the only one who can ask to complete.
 *
 * `not_found` is not here either, and that is the whole of finding 5a. It means
 * "no such project, OR the name did not match" - the second half is a project
 * that still exists under a new name, and there is no reading of it under which
 * `onDeleted` and a `Deleted "name"` toast are true.
 */
const CLOSING_OUTCOMES: ReadonlySet<ProjectDeleteResult["outcome"]> = new Set([
  "removed",
  "already_removed",
]);

/**
 * The outcomes that prove a TOMBSTONE EXISTS for this project, so main now owns
 * the trash decision and a retry only resumes the request it recorded.
 *
 * Deliberately NOT `outcomePinsRow`: both `blocked_*` members pin the row but
 * wrote NOTHING, so their retry is a first attempt and its checkbox is still a
 * real choice. Only the four below mean the durable decision has been made.
 *
 * Within one dialog's life the FIRST of these is always the attempt that
 * created the tombstone, because a row that is already tombstoned cannot be in
 * the list this dialog's project comes from (`listProjects` reads
 * `WHERE deleted_at IS NULL`).
 */
const DURABLE_TOMBSTONE_OUTCOMES: ReadonlySet<ProjectDeleteResult["outcome"]> =
  new Set(["removed", "already_removed", "cleanup_pending", "cleanup_resumed"]);

/**
 * Does this outcome leave the dialog standing on a row the LIST is about to
 * drop?
 *
 * `useDeleteProject` invalidates the list on every ok Result, so a tombstoned
 * row leaves it moments later. Every outcome that keeps this dialog open about
 * a project main has already written off - `cleanup_pending`, `cleanup_resumed`
 * and a `removed` whose trash failed - therefore pins the row it submitted
 * against. The two `blocked_*` members wrote nothing and their row survives,
 * but they pin on the same rule rather than on the hope that it does.
 *
 * `not_found` is the exception, on purpose: it is the one open outcome whose
 * remedy IS the reloaded list.
 */
function outcomePinsRow(result: ProjectDeleteResult): boolean {
  if (result.outcome === "not_found") return false;
  if (!CLOSING_OUTCOMES.has(result.outcome)) return true;
  return "trash" in result && result.trash === "failed";
}

export interface ProjectDeleteDialogProps {
  /** `null` closes the dialog. The row as the list holds it. */
  readonly project: ProjectDto | null;
  readonly onClose: () => void;
  /**
   * The project is gone. The caller repairs its own selection and workspace
   * state; this dialog owns no shell state.
   *
   * Called ONLY for an outcome that proves the project was removed. `not_found`
   * proves nothing of the kind and never calls it.
   */
  readonly onDeleted: (projectId: string) => void;
  /**
   * This dialog is reporting an outcome about a row the list is dropping, and
   * the host must HOLD THE REQUEST OPEN until the user leaves.
   *
   * The signal is a boolean because the decision belongs here: this component
   * already owns which outcomes end the interaction, and duplicating that rule
   * in the host would be a second source of truth for it. The host owns the
   * other half - whether the standing request survives a project leaving the
   * list - and nothing but this flag crosses between them.
   *
   * Must be referentially stable; a `useState` setter is.
   */
  readonly onHoldOpen: (held: boolean) => void;
}

export function ProjectDeleteDialog({
  project,
  onClose,
  onDeleted,
  onHoldOpen,
}: ProjectDeleteDialogProps): JSX.Element {
  const deleteMutation = useDeleteProject();

  const [alsoTrashFolder, setAlsoTrashFolder] = useState(false);
  const [typedName, setTypedName] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<ProjectDeleteResult | null>(null);
  /**
   * The row this dialog SUBMITTED AGAINST, kept once an outcome left the dialog
   * open about a project the list is dropping. Null until that happens, so the
   * ordinary path reads the live row and nothing here goes stale.
   */
  const [pinned, setPinned] = useState<ProjectDto | null>(null);
  /**
   * The trash choice this dialog SUBMITTED on the attempt that made the delete
   * durable, and therefore the one the tombstone recorded. `null` until such an
   * outcome arrives, which is exactly the window in which the checkbox is still
   * a real choice.
   */
  const [recordedTrash, setRecordedTrash] = useState<boolean | null>(null);

  /**
   * The row this dialog is about. The live list row while there is one, the pin
   * afterwards. Everything below reads THIS, never `project`: with the row
   * tombstoned and gone from the list the pin is the only remaining statement
   * of what the retry is for.
   */
  const row = project ?? pinned;
  const open = row !== null;

  // A DIFFERENT live row is a different dialog (the intent store lets one
  // request replace another), so a pin from the previous one must not survive
  // into it. Returning `current` unchanged when the ids match keeps every list
  // refetch, which hands us a fresh DTO identity, from re-rendering.
  useEffect(() => {
    if (project === null) return;
    setPinned((current) =>
      current !== null && current.id !== project.id ? null : current,
    );
  }, [project]);

  // Reset on every (re)open. A checkbox or a typed name surviving from the
  // previous project would arm this dialog against a row the user has not
  // looked at.
  useEffect(() => {
    if (!open) return;
    setAlsoTrashFolder(false);
    setRecordedTrash(null);
    setTypedName("");
    setSubmitError(null);
    setOutcome(null);
  }, [open, row?.id]);

  // Tell the host whether the standing request must outlive the row.
  useEffect(() => {
    onHoldOpen(pinned !== null);
  }, [onHoldOpen, pinned]);
  // And release the hold when this dialog goes, whatever took it away.
  useEffect(() => {
    return () => {
      onHoldOpen(false);
    };
  }, [onHoldOpen]);

  /**
   * How many terminals this project has live IN THIS WINDOW, or null when the
   * renderer does not know. Read once per opening, not per render: the count is
   * a statement about the moment the user is deciding, and a number that
   * changed under the confirmation would be a different dialog.
   */
  const liveTerminalCount = useMemo(() => {
    if (row === null) return null;
    return peekProjectTerminals(row.id)?.length ?? null;
    // `row?.id` rather than `row`: the DTO object identity changes on every
    // list refetch and would re-read a count that must not move.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.id]);

  /**
   * The value that goes on the wire and the value the checkbox shows: the
   * recorded one once the delete is durable, the user's live one before that.
   * One expression, so what is displayed and what is sent cannot diverge.
   */
  const trashFrozen = recordedTrash !== null;
  const trashChoice = recordedTrash ?? alsoTrashFolder;

  const nameMatches = row !== null && typedName.trim() === row.name;
  const pending = deleteMutation.isPending;
  const confirmDisabled = !nameMatches || pending;

  const onConfirm = useCallback(async (): Promise<void> => {
    if (row === null || !nameMatches || pending) return;
    setSubmitError(null);
    const result = await deleteMutation.mutateAsync({
      projectId: row.id,
      alsoTrashFolder: trashChoice,
      expectedName: row.name,
    });
    if (!result.ok) {
      setSubmitError(result.error.message);
      return;
    }
    setOutcome(result.data);
    // FREEZE the folder choice the moment the tombstone is proven to exist,
    // recording the value this attempt sent. `current ?? ...` keeps the FIRST
    // recording: a later `cleanup_resumed` reports on the same tombstone and
    // must not overwrite what that tombstone was created with.
    if (DURABLE_TOMBSTONE_OUTCOMES.has(result.data.outcome)) {
      setRecordedTrash((current) => current ?? trashChoice);
    }
    // Pinned BEFORE anything that can close: the list invalidation this Result
    // just triggered is already in flight.
    if (outcomePinsRow(result.data)) setPinned(row);
    if (CLOSING_OUTCOMES.has(result.data.outcome)) {
      // A trash that FAILED keeps the dialog open even on `removed`: the folder
      // is still on disk and that is a fact the user has to act on, not one to
      // flash past in a toast.
      const trashFailed =
        "trash" in result.data && result.data.trash === "failed";
      onDeleted(row.id);
      if (!trashFailed) {
        showToast(projectDeletedToast(row.name));
        onClose();
      }
    }
  }, [
    deleteMutation,
    nameMatches,
    onClose,
    onDeleted,
    pending,
    row,
    trashChoice,
  ]);

  const name = row?.name ?? "";
  // The warning treatment is the CHECKBOX's, not the dialog's: it appears the
  // moment the action starts touching the user's files and goes when it stops.
  const warned = trashChoice;

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
              "flex items-start gap-2.5 rounded-lg border px-3 py-2.5 transition-colors",
              trashFrozen ? "cursor-default" : "cursor-pointer",
              warned
                ? "border-warning/40 bg-warning-wash"
                : trashFrozen
                  ? "border-line-2"
                  : "border-line-2 hover:bg-interactive-hover",
            )}
            data-vex-delete-trash-frozen={trashFrozen ? "true" : undefined}
          >
            <input
              type="checkbox"
              checked={trashChoice}
              // Frozen, not merely busy: main owns this decision from the
              // tombstone onwards, so the control must stop offering a choice
              // it can no longer carry.
              disabled={pending || trashFrozen}
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
              {trashFrozen ? (
                <span className="text-xs text-ink-tertiary">
                  {PROJECT_DELETE_TRASH_LOCKED_NOTE}
                </span>
              ) : null}
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
