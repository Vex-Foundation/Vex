/**
 * The opener for the launch dialog — READY TO MOUNT, NOT MOUNTED.
 *
 * `AppShell.tsx` and `BookPanel.tsx` composition is coordinator-owned (§4b), so
 * this exports a self-contained control that owns nothing but its own open
 * state. A host that wants to drive the dialog itself (the agent-requested
 * Path 1, which opens it with an existing `intentId`) should skip this and
 * render `TokenLaunchDialog` directly with its own state — hence the two
 * exports rather than one coupled blob.
 *
 * Origin is `"user"` here by definition: the user pressed a button. That
 * matters downstream — a `user`-origin launch answers no pending tool call and
 * must NOT resume an agent turn (§C6 lifecycle), so the origin cannot be a
 * default someone forgets to override.
 */

import { useState, type JSX } from "react";
import { TokenLaunchDialog } from "../TokenLaunchDialog.js";

export function TokenLaunchButton({
  sessionId,
  className,
}: {
  readonly sessionId: string | null;
  readonly className?: string;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={
          className ??
          "w-full rounded-full border border-[var(--vex-line)] py-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-[var(--vex-text-2)] transition-colors hover:text-[var(--vex-text)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]"
        }
      >
        Launch a token
      </button>
      <TokenLaunchDialog
        open={open}
        onOpenChange={setOpen}
        sessionId={sessionId}
        origin="user"
      />
    </>
  );
}
