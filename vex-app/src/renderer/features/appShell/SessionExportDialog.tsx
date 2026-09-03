/**
 * Pre-save confirmation for "Export session as Markdown".
 *
 * Export privacy contract: the user must see, before any file is written,
 * that the export contains the session's conversation content and that
 * secrets are only redacted on a best-effort basis (the export can include
 * archived historical content, which is exactly where old accidental
 * secret exposure lives — see `../../../main/sessions/export-redaction.js`).
 * Confirming here only opens the native save dialog; nothing is written
 * until the user also picks a destination there.
 */

import type { JSX } from "react";
import type { SessionListItem } from "@shared/schemas/sessions.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../components/ui/dialog.js";
import { getSessionTitle } from "./sessionListModel.js";

interface SessionExportDialogProps {
  readonly session: SessionListItem | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function SessionExportDialog({
  session,
  pending,
  onCancel,
  onConfirm,
}: SessionExportDialogProps): JSX.Element {
  const open = session !== null;
  const title = session === null ? "" : getSessionTitle(session);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader className="border-line-2">
          <DialogTitle>Export session as Markdown?</DialogTitle>
          <DialogDescription className="text-ink-secondary">
            {`Save a readable transcript of "${title}" to a file you choose. Secrets are redacted automatically on a best-effort basis - review the file before sharing it.`}
          </DialogDescription>
        </DialogHeader>

        <DialogBody className="gap-3" />

        <DialogFooter className="border-line-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onCancel}
            disabled={pending}
            // The safer choice takes focus (rule 08). `DialogContent` moves
            // focus here after `showModal()`; React's `autoFocus` prop cannot,
            // because React never renders it as the attribute the focusing
            // steps read.
            {...DIALOG_INITIAL_FOCUS}
            className="text-ink-secondary hover:bg-interactive-hover hover:text-ink-primary"
          >
            Cancel
          </Button>
          <Button type="button" onClick={onConfirm} disabled={pending}>
            {pending ? "Exporting…" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
