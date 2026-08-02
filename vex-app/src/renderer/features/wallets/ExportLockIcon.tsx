/**
 * Inline lock glyph for the export modal (extracted from
 * `ExportPrivateKeyModal.tsx` to keep that file under the size budget).
 * Same as UnlockScreen.LockIcon, this is a hand-inlined path rather than a
 * glyph from `components/icons` — kept as-is so the vendor swap stayed a
 * mechanical change. Routing it through `VexIcon` is a separate step.
 */

import type { JSX } from "react";

export function ExportLockIcon(): JSX.Element {
  return (
    <svg
      aria-hidden
      className="h-5 w-5 text-destructive"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
