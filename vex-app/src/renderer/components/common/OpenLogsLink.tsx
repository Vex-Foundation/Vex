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
        // Token-driven, not hardcoded accent. The label reads
        // `--vex-accent-text` - the accent's lighter mix - because accent AS
        // TEXT needs it: raw accent falls short of contrast on the plate.
        // Both the gate and shell scopes define the token; the fallback
        // covers any surface that defines neither. The focus ring is a solid
        // accent mark, so it keeps --color-ring.
        "self-start font-mono text-xs text-[var(--vex-accent-text,var(--color-accent-hover))] underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base",
        className,
      )}
    >
      Open logs folder
    </button>
  );
}
