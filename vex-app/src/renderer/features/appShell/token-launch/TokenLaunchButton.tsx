/**
 * The opener for the launch dialog - READY TO MOUNT, NOT MOUNTED.
 *
 * `AppShell.tsx` and `BookPanel.tsx` composition is coordinator-owned (§4b), so
 * this exports a self-contained control that owns nothing but its own open
 * state. A host that wants to drive the dialog itself (the agent-requested
 * Path 1, which opens it with an existing `intentId`) should skip this and
 * render `TokenLaunchDialog` directly with its own state - hence the two
 * exports rather than one coupled blob.
 *
 * Origin is `"user"` here by definition: the user pressed a button. That
 * matters downstream - a `user`-origin launch answers no pending tool call and
 * must NOT resume an agent turn (§C6 lifecycle), so the origin cannot be a
 * default someone forgets to override.
 *
 * LOOK (docs/design/R3-MINIMAL.md sections 1.5 and 8.2): a quiet small key (the
 * kit `Button`, rule outline, 32 high), full width by default. A caller that
 * passes `className` replaces the default width exactly as before.
 */

import { useState, type JSX } from "react";
import { Button } from "../../../components/ui/button.js";
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
      <Button
        type="button"
        variant="quiet"
        size="sm"
        onClick={() => setOpen(true)}
        className={className ?? "w-full"}
      >
        Launch a token
      </Button>
      <TokenLaunchDialog
        open={open}
        onOpenChange={setOpen}
        sessionId={sessionId}
        origin="user"
      />
    </>
  );
}
