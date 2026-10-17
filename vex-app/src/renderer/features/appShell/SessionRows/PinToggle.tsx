/**
 * Pin/unpin key for a session row (docs/design/R3-MINIMAL.md section 4): a
 * 24 x 24 key with the line pin, ink 2 at rest and blue while the row is
 * pinned. It lives in a sibling cluster outside the row-select button (never
 * nested), so its click does not bubble into the row-select handler. The row
 * owns the reveal; this key only carries the glyph and its two inks.
 */

import type { JSX, MouseEvent } from "react";
import { LinePin } from "../../../components/icons/line/index.js";
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
      data-pinned={pinned || undefined}
      className={cn(
        "inline-flex h-6 w-6 items-center justify-center border-0 bg-transparent focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--vex-alias-focus)]",
        pinned
          ? "text-accent-primary"
          : "text-ink-secondary hover:text-ink-primary",
        pending && "cursor-wait opacity-60",
        className,
      )}
    >
      <LinePin size={14} />
    </button>
  );
}
