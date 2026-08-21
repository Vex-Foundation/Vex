import type { JSX } from "react";
import { cn } from "../../lib/utils.js";

interface OpenLogsLinkProps {
  readonly className?: string;
}

export function OpenLogsLink({ className }: OpenLogsLinkProps): JSX.Element {
  return (
    <button
      type="button"
      data-vex-open-logs
      onClick={() => {
        void window.vex.support.openLogsFolder().catch(() => undefined);
      }}
      className={cn(
        // Inter Tight, NOT mono: this is a UI action label, and mono is
        // reserved for technical artifacts - code, JSON, addresses, hashes
        // (design-language §4). Colour is token-driven: `--vex-accent-text`
        // is the accent tuned for use AS TEXT, defined by both the gate and
        // shell scopes; the fallback covers any surface defining neither.
        //
        // The ring offset is TRANSPARENT, not a surface token: this link
        // renders on the pre-shell plate, on shell surfaces and inside
        // dialogs, and any fixed offset colour cuts a wrong-coloured halo on
        // the other two. A transparent offset band lets whatever is actually
        // behind the link show through, in both themes.
        "self-start text-xs text-[var(--vex-accent-text,var(--color-accent-primary))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-transparent",
        className,
      )}
    >
      Open logs folder
    </button>
  );
}
