import { useState, type JSX } from "react";
import type { ApprovalActionResult, ApprovalSummaryDto } from "@shared/schemas/approvals.js";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "../../../components/ui/dialog.js";
import { ApprovalCard } from "../ApprovalCard.js";
import { isDeskCloseApproval } from "./desk-approvals.js";

/**
 * The desk's own approval cards, as a modal over the desk.
 *
 * A card with `origin: "desk"` is the user's click (Close, Cancel, the
 * ticket's Long/Short) turned into a proposal by main - no model behind it,
 * nothing for a chat to show. It pops here; the agent's proposals stay in the
 * chat rail. ESC hides the dialog until another card arrives; the card itself
 * stays pending in the shell's AWAITING badge until it expires.
 *
 * A Market close card also offers "Don't ask again": ticking it makes the
 * desk approve later close cards itself. This card still waits for Confirm.
 */
export function DeskApprovalDialog({ approvals, sessionId, focusApprovalId, onResolved, skipCloseConfirm, onSkipCloseConfirm }: {
  readonly approvals: ReadonlyArray<ApprovalSummaryDto>;
  readonly sessionId: string;
  readonly focusApprovalId: string | null;
  readonly onResolved: (decision: "approved" | "rejected", result: ApprovalActionResult) => void;
  readonly skipCloseConfirm: boolean;
  readonly onSkipCloseConfirm: (next: boolean) => void;
}): JSX.Element {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const open = approvals.some((summary) => !dismissed.has(summary.id));
  const showsClose = approvals.some(isDeskCloseApproval);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setDismissed(new Set(approvals.map((summary) => summary.id)));
      }}
    >
      <DialogContent
        data-vex-area="lighter-desk-approval"
        className="w-[calc(100vw-3rem)] max-w-[560px]"
        closeOnBackdropClick={false}
      >
        <DialogHeader>
          <DialogTitle>Approve order</DialogTitle>
          <DialogDescription>Nothing signs until you confirm.</DialogDescription>
        </DialogHeader>
        <DialogBody className="gap-3 px-3 pb-4 pt-0">
          {approvals.map((summary) => (
            <ApprovalCard
              key={summary.id}
              summary={summary}
              sessionId={sessionId}
              focusOnMount={summary.id === focusApprovalId}
              idVariant="lighter-desk"
              onResolved={onResolved}
            />
          ))}
          {showsClose ? (
            <label className="lit-desk-skip-confirm">
              <input
                type="checkbox"
                checked={skipCloseConfirm}
                onChange={(event) => onSkipCloseConfirm(event.target.checked)}
              />
              Don't ask again for Market close
            </label>
          ) : null}
        </DialogBody>
      </DialogContent>
    </Dialog>
  );
}
