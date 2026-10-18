/**
 * Confirmation dialog for the "Remove session" action
 * (docs/design/R3-MINIMAL.md section 12).
 *
 * Uses the existing native `<dialog>` primitive so we get focus trap +
 * ESC + restore-focus for free. A destructive confirm must block, so it
 * keeps the flat paper scrim behind it. The default focus lands on Cancel
 * (destructive actions default to the least destructive option); Remove is
 * the ink key of the refusing kind, never a blue fill.
 *
 * Outcome-aware: the description swaps to a blocked-state copy when
 * main refuses to remove the session because of an active mission run
 * or a pending approval, with the ink hatch swatch beside it. The user can
 * resolve the blocker and click Remove again, with no error toast and no
 * destructive fallback path.
 */

import type { JSX } from "react";
import type { SessionDeleteOutcome, SessionListItem } from "@shared/schemas/sessions.js";
import { Button } from "../../components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DIALOG_INITIAL_FOCUS,
} from "../../components/ui/dialog.js";
import { Swatch } from "../../components/ui/swatch.js";
import { getSessionTitle } from "./sessionListModel.js";

interface SessionDeleteDialogProps {
  readonly session: SessionListItem | null;
  readonly blockedOutcome: SessionDeleteOutcome | null;
  readonly pending: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

export function SessionDeleteDialog({
  session,
  blockedOutcome,
  pending,
  onCancel,
  onConfirm,
}: SessionDeleteDialogProps): JSX.Element {
  const open = session !== null;
  const title = session === null ? "" : getSessionTitle(session);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      {/* The R3 dialog frame is the Dialog base; only the width is per-modal.
       * The scrim stays: removing a session must be decided before anything
       * else on the page can be touched. */}
      <DialogContent className="max-w-md" backdrop="scrim">
        <DialogHeader className="pb-5">
          <DialogTitle>Remove session?</DialogTitle>
          <DialogDescription className="text-[13.5px] leading-[1.5]">
            {blockedOutcome === null ? null : (
              <Swatch
                state="concerned"
                size={10}
                className="mr-2 inline-block align-middle"
              />
            )}
            {describeOutcome(title, blockedOutcome)}
          </DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button
            type="button"
            variant="quiet"
            onClick={onCancel}
            disabled={pending}
            // The safer choice takes focus (rule 08). `DialogContent` moves
            // focus here after `showModal()`; React's `autoFocus` prop cannot,
            // because React never renders it as the attribute the focusing
            // steps read.
            {...DIALOG_INITIAL_FOCUS}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant="ink"
            onClick={onConfirm}
            disabled={pending}
          >
            {pending ? "Removing…" : "Remove"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function describeOutcome(
  title: string,
  outcome: SessionDeleteOutcome | null,
): string {
  if (outcome === "blocked_active_mission") {
    return `Can't remove "${title}" - this mission is still active. Stop the mission first, then try again.`;
  }
  if (outcome === "blocked_pending_approval") {
    return `Can't remove "${title}" - this session has a pending approval. Resolve it first, then try again.`;
  }
  if (outcome === "state_changed") {
    return "Session state changed since you opened this dialog. Try again.";
  }
  // Initial state - honest soft-delete copy.
  return `Remove "${title}" from your sidebar. Local message history stays on your disk; this only hides it from the app.`;
}
