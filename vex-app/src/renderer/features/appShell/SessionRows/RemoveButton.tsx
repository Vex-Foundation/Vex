/**
 * Trash action for a session row. Lives in a sibling cluster outside the
 * row-select button (never nested), so its click does not bubble into the
 * row-select handler. Hidden until row hover / focus-within.
 *
 * Extracted verbatim from `SessionRows.tsx`. Purely presentational.
 */

import type { JSX, MouseEvent } from "react";
import { Delete02Icon, VexIcon } from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";

export function RemoveButton({
  onClick,
}: {
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Remove session"
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border border-transparent text-[var(--color-text-muted)] transition-colors",
        "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100",
        "hover:bg-destructive/10 hover:text-destructive",
        "focus-visible:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
      )}
    >
      <VexIcon icon={Delete02Icon} size={13} aria-hidden />
    </button>
  );
}
