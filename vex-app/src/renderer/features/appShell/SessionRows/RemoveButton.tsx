/**
 * Remove key for a session row (docs/design/R3-MINIMAL.md section 4): a
 * 24 x 24 key with the line trash in ink 2. It lives in a sibling cluster
 * outside the row-select button (never nested), so its click does not bubble
 * into the row-select handler. The row owns the reveal.
 */

import type { JSX, MouseEvent } from "react";
import { LineTrash } from "../../../components/icons/line/index.js";

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
      className="inline-flex h-6 w-6 items-center justify-center border-0 bg-transparent text-ink-secondary hover:text-ink-primary focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--vex-alias-focus)]"
    >
      <LineTrash size={14} />
    </button>
  );
}
