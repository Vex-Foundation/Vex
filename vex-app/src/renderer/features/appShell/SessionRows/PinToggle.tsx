/**
 * Pin/unpin toggle for a session row. Lives in a sibling cluster outside the
 * row-select button (never nested), so its click does not bubble into the
 * row-select handler. Pinned rows stay visible; unpinned rows reveal the star
 * on row hover / focus-within.
 *
 * Extracted verbatim from `SessionRows.tsx`. Purely presentational.
 */

import type { JSX, MouseEvent } from "react";
import { StarIcon, VexIcon } from "../../../components/icons/index.js";
import { cn } from "../../../lib/utils.js";

export function PinToggle({
  pinned,
  pending,
  onClick,
  className,
}: {
  readonly pinned: boolean;
  readonly pending: boolean;
  readonly onClick: (event: MouseEvent<HTMLButtonElement>) => void;
  readonly className?: string;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={pinned}
      aria-label={pinned ? "Unpin session" : "Pin session"}
      disabled={pending}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--vex-accent)]",
        pinned
          ? "border-[var(--vex-pin-border)] bg-[var(--vex-pin-fill)] text-[var(--vex-pin)] hover:bg-[var(--vex-pin-fill-hover)]"
          : "border-transparent text-[var(--vex-text-3)] opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-white/[0.06] hover:text-foreground",
        pending && "cursor-wait opacity-60",
        className,
      )}
    >
      <VexIcon icon={StarIcon} size={13} aria-hidden />
    </button>
  );
}
