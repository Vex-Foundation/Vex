/**
 * Trash action for a session row. Lives in a sibling cluster outside the
 * row-select button (never nested), so its click does not bubble into the
 * row-select handler. Reveal is owned by the RailRow actions cluster.
 */

import type { JSX, MouseEvent } from "react";
import { IconTrash } from "../../../components/icons/index.js";
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
        "inline-flex h-6 w-6 items-center justify-center rounded border-0 text-ink-tertiary transition-colors",
        "hover:text-danger",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
      )}
    >
      <IconTrash size={13} />
    </button>
  );
}
