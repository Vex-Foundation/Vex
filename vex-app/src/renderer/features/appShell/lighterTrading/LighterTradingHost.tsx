import type { JSX } from "react";
import { LighterTradingDialog } from "./LighterTradingDialog.js";

export function LighterTradingHost({
  activeSessionId,
  open,
  onOpenChange,
}: {
  readonly activeSessionId: string | null;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}): JSX.Element {
  return (
    <>
      <button
        type="button"
        className="lit-launcher"
        onClick={() => onOpenChange(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <img src="./protocols/lighter.svg" alt="" width="20" height="20" />
        <span>Light it up</span>
      </button>
      <LighterTradingDialog
        open={open}
        activeSessionId={activeSessionId}
        onOpenChange={onOpenChange}
      />
    </>
  );
}
