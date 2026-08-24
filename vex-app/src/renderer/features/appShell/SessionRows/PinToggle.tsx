/**
 * Pin/unpin toggle for a session row. Lives in a sibling cluster outside the
 * row-select button (never nested), so its click does not bubble into the
 * row-select handler. Reveal is owned by the RailRow actions cluster; this
 * button only carries the pin glyph and its tones.
 */

import type { JSX, MouseEvent } from "react";
import { IconStar, IconStarFill } from "../../../components/icons/index.js";
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
        "inline-flex h-6 w-6 items-center justify-center rounded border-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-primary",
        pinned
          ? "text-warning hover:text-warning-label"
          : "text-ink-tertiary hover:text-ink-primary",
        pending && "cursor-wait opacity-60",
        className,
      )}
    >
      {pinned ? <IconStarFill size={13} /> : <IconStar size={13} />}
    </button>
  );
}
