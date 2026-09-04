/**
 * THE DELETE CONFIRMATION for one file or folder in the tree.
 *
 * `ProjectDeleteDialog`'s consent grammar, at the weight this action actually
 * carries. The three-line strip is the same and in the same order - WHAT is
 * being deleted, WHERE it goes, WHETHER it can be undone - because that is the
 * shape a Vex destructive confirmation has, and a second grammar for the second
 * destructive surface is how the two drift into saying different things about
 * the same kind of act.
 *
 * WHAT IS NOT COPIED, and why: the project dialog demands the project's NAME be
 * TYPED. That gate exists there because a project row sits in a list of
 * similar-looking rows and the action is irreversible and unbounded - it takes
 * a session, an approval audit and a folder with it. Here the subject is one
 * entry the user right-clicked or focused, the default disposition is the
 * system TRASH, and the action is recoverable. A typed confirmation on a
 * recoverable single-file delete is friction that trains people to type through
 * confirmations, which is how the typed gate stops working where it matters.
 *
 * THE REGISTER FOLLOWS THE DISPOSITION. A trash delete is an ordinary
 * destructive confirmation; a PERMANENT one takes the warning treatment,
 * because the undo line stops being "you can restore it" and becomes "nothing
 * can bring it back". Same mechanism the project dialog uses for its checkbox:
 * state tokens on the existing primitive, never a new dialog variant.
 *
 * FOCUS DEFAULTS TO CANCEL (rule 08: a dangerous action defaults to the safer
 * choice), through `DIALOG_INITIAL_FOCUS` - React's `autoFocus` prop cannot do
 * it, because React never renders it as the attribute the dialog's focusing
 * steps read.
 *
 * A TRASH THAT REFUSED IS NOT A FAILURE TO REPORT AND FORGET. The entry is
 * still on disk, so the dialog stays open and OFFERS permanent deletion as a
 * second decision with its own irreversible sentence and its own press. It
 * never switches disposition on the user's behalf: the sentence they agreed to
 * said they could restore it.
 */

import { useCallback, useEffect, useState, type JSX } from "react";
import type { FileDeleteMode, FileNode } from "@shared/schemas/files.js";
import { Button } from "../../../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogConsequence,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogPinnedSlot,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../../../components/ui/dialog.js";
import { SubmitError } from "../../../../components/ui/submit-error.js";
import { useLiveAnnouncer } from "../../../../components/ui/live-region.js";
import { cn } from "../../../../lib/utils.js";
import {
  EXPLORER_DELETE_CANCEL,
  EXPLORER_DELETE_PENDING,
  EXPLORER_DELETE_TITLE,
  EXPLORER_TRASH_UNAVAILABLE_OFFER,
  deleteConfirmLabel,
  deleteConsequenceWhat,
  deleteDispositionLine,
  deleteUndoLine,
  deletedAnnouncement,
} from "./explorer-copy.js";

/** What the tree asked this dialog to confirm. `null` closes it. */
export interface ExplorerDeleteRequest {
  readonly node: FileNode;
  /** The disposition the KEY or the menu row chose. The dialog may raise it. */
  readonly mode: FileDeleteMode;
}

export interface ExplorerDeleteDialogProps {
  readonly request: ExplorerDeleteRequest | null;
  readonly onClose: () => void;
  /**
   * Perform the delete. Resolves with what happened.
   *
   * The dialog owns CONSENT and nothing else: the session owns the write, the
   * optimistic row and the refresh. Splitting it the other way would put a
   * privileged effect behind a component that can be unmounted mid-flight.
   */
  readonly onConfirm: (
    node: FileNode,
    mode: FileDeleteMode,
  ) => Promise<
    | { readonly ok: true }
    | { readonly ok: false; readonly code: string | null; readonly message: string }
  >;
}

export function ExplorerDeleteDialog({
  request,
  onClose,
  onConfirm,
}: ExplorerDeleteDialogProps): JSX.Element {
  /**
   * The disposition this dialog will send.
   *
   * It starts as the one the user's key or menu row chose and can only be
   * RAISED - trash to permanent - and only by an explicit press after the trash
   * refused. It never falls back on its own.
   */
  const [mode, setMode] = useState<FileDeleteMode>(request?.mode ?? "trash");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [trashRefused, setTrashRefused] = useState(false);
  const { announce, region: liveRegion } = useLiveAnnouncer();

  const open = request !== null;
  const nodeId = request?.node.nodeId ?? null;

  // Reset on every (re)open. A raised disposition or a stale refusal surviving
  // from the previous entry would arm this dialog against a file the user has
  // not looked at.
  useEffect(() => {
    if (!open) return;
    setMode(request.mode);
    setPending(false);
    setFailure(null);
    setTrashRefused(false);
    // `nodeId` rather than `request`: the object identity changes on every
    // render of the host and would reset a dialog the user is reading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, nodeId]);

  const confirm = useCallback(async (): Promise<void> => {
    if (request === null || pending) return;
    setPending(true);
    setFailure(null);
    const outcome = await onConfirm(request.node, mode);
    setPending(false);
    if (outcome.ok) {
      announce("info", deletedAnnouncement(request.node.name, mode));
      onClose();
      return;
    }
    // THE ENTRY IS STILL THERE. Offer the second disposition rather than
    // taking it: the sentence the user agreed to said they could restore it.
    if (outcome.code === "trash_unavailable") {
      setTrashRefused(true);
      setMode("permanent");
      setFailure(EXPLORER_TRASH_UNAVAILABLE_OFFER);
      announce("error", EXPLORER_TRASH_UNAVAILABLE_OFFER);
      return;
    }
    setFailure(outcome.message);
    announce("error", outcome.message);
  }, [announce, mode, onClose, onConfirm, pending, request]);

  const name = request?.node.name ?? "";
  const kind = request?.node.kind ?? "file";
  const warned = mode === "permanent";

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !pending) onClose();
      }}
    >
      <DialogContent
        className={cn("max-w-md", warned && "border-warning/40")}
        // An explicit choice, never a stray backdrop click.
        closeOnBackdropClick={false}
        data-vex-explorer-delete-mode={mode}
      >
        <DialogHeader className="border-line-2">
          <DialogTitle>{EXPLORER_DELETE_TITLE}</DialogTitle>
        </DialogHeader>

        {/* The consent strip: WHAT, WHERE, WHETHER-UNDOABLE, in that order and
          * in the same register the project delete uses. */}
        <DialogConsequence data-vex-consent="delete-file">
          <span className="font-medium">{deleteConsequenceWhat(name, kind)}</span>
          {request === null ? null : (
            <span className="truncate font-mono text-[11px] text-ink-secondary">
              {request.node.path}
            </span>
          )}
          <span className="text-ink-secondary">{deleteDispositionLine(mode)}</span>
          <span className={warned ? "text-warning" : "text-ink-secondary"}>
            {deleteUndoLine(mode)}
          </span>
        </DialogConsequence>

        <DialogBody className="gap-3" />

        {failure === null ? null : (
          // PINNED beside the button that was just pressed, not at the bottom of
          // a scrolling body where a refusal for a destructive action can sit
          // below the fold and never be read.
          <DialogPinnedSlot>
            <SubmitError submitError={failure} />
          </DialogPinnedSlot>
        )}

        {liveRegion}

        <DialogFooter className="border-line-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onClose}
            disabled={pending}
            // The safer choice takes focus (rule 08).
            {...DIALOG_INITIAL_FOCUS}
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            {EXPLORER_DELETE_CANCEL}
          </Button>
          <Button
            type="button"
            variant="danger"
            onClick={() => void confirm()}
            disabled={pending}
            data-vex-explorer-delete-confirm={trashRefused ? "permanent-offer" : "primary"}
          >
            {pending ? EXPLORER_DELETE_PENDING : deleteConfirmLabel(mode)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
