/**
 * Topbar trigger for the local-first "Report an issue" dialog.
 *
 * Phase 1: owns the dialog open state via local React state — there is no
 * cross-feature reason to lift this into useUiStore yet. Lifts when Phase 2
 * adds prefilled-report actions in error states elsewhere in the UI.
 */

import { useCallback, useState } from "react";
import type { JSX } from "react";
import { IconBug } from "../../components/icons/index.js";
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
        variant="ghost"
        size={compact ? "icon" : "sm"}
        onClick={openDialog}
        aria-label="Report an issue"
        aria-haspopup="dialog"
        className="border border-[var(--vex-line-strong)] bg-transparent text-[var(--vex-text-2)] hover:bg-white/[0.04] hover:text-foreground"
      >
        <IconBug size={16} />
        {compact ? null : <span>Report issue</span>}
      </Button>
      <ReportIssueDialog open={open} onOpenChange={onOpenChange} />
    </>
  );
}
