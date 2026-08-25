import { useEffect, type JSX } from "react";
import { LighterTradingDialog } from "./LighterTradingDialog.js";
import { subscribeLighterWorkspaceOpen } from "./workspace-command.js";

export function LighterTradingHost({
  activeSessionId,
  open,
  onOpenChange,
}: {
  readonly activeSessionId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  useEffect(
    () => subscribeLighterWorkspaceOpen(() => onOpenChange(true)),
    [onOpenChange],
  );

  return (
    <LighterTradingDialog
      open={open}
      activeSessionId={activeSessionId}
      onOpenChange={onOpenChange}
    />
  );
}
