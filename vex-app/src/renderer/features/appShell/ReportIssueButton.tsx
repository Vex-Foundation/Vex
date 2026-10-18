/**
 * Topbar trigger for the local-first "Report an issue" dialog.
 *
 * Phase 1: owns the dialog open state via local React state - there is no
 * cross-feature reason to lift this into useUiStore yet. Lifts when Phase 2
 * adds prefilled-report actions in error states elsewhere in the UI.
 *
 * R3 Minimal (docs/design/R3-MINIMAL.md sections 1.5 and 1.7): the quiet rule
 * key (32 high, or the 32 x 32 icon key when compact) with the line warning
 * icon.
 */

import { useCallback, useState } from "react";
import type { JSX } from "react";
import { LineWarning } from "../../components/icons/line/index.js";
import { Button } from "../../components/ui/button.js";
import { ReportIssueDialog } from "./ReportIssueDialog.js";

interface ReportIssueButtonProps {
  readonly compact?: boolean;
}

export function ReportIssueButton({
  compact = false,
}: ReportIssueButtonProps): JSX.Element {
  const [open, setOpen] = useState<boolean>(false);
  const openDialog = useCallback(() => setOpen(true), []);
  const onOpenChange = useCallback((next: boolean) => setOpen(next), []);
  return (
    <>
      <Button
        variant="quiet"
        size={compact ? "icon" : "sm"}
        onClick={openDialog}
        aria-label="Report an issue"
        aria-haspopup="dialog"
      >
        <LineWarning size={16} />
        {compact ? null : <span>Report issue</span>}
      </Button>
      <ReportIssueDialog open={open} onOpenChange={onOpenChange} />
    </>
  );
}
