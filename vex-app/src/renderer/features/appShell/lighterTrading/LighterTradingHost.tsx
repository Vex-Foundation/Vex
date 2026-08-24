import { useState, type JSX } from "react";
import { LighterTradingDialog } from "./LighterTradingDialog.js";

export function LighterTradingHost({ activeSessionId }: {
  readonly activeSessionId: string | null;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        className="lit-launcher"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <img src="./protocols/lighter.svg" alt="" width="20" height="20" />
        <span>Light it up</span>
      </button>
      <LighterTradingDialog
        open={open}
        activeSessionId={activeSessionId}
        onOpenChange={setOpen}
      />
    </>
  );
}
