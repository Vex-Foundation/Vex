/**
 * Shared presentational primitives for the Memory panel.
 *
 * Extracted from `MemoryPanel.tsx` so each section module stays under the
 * 400-line budget. Panel-local — NOT a generic UI helper. Holds only the
 * primitives used by more than one section: the section/pill class constants,
 * the loading/error/empty states, and the date formatter.
 *
 * S7 reskin: sections are hairline-separated ledger groups on the canvas
 * (no card boxes), metadata pills are quiet mono stamps (hairline border,
 * never accent — accent stamps are reserved for exception states), and the
 * loading state is a recessed surface-down well.
 */

import type { JSX } from "react";

export const SECTION =
  "flex flex-col gap-3 border-b border-line-2 py-6 first:pt-0 last:border-b-0";
export const PILL =
  "inline-flex items-center rounded-[3px] border border-line-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary";

export function Loading({ label }: { readonly label: string }): JSX.Element {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-[6px] border border-line-2 bg-surface-1 px-3 py-2 text-xs text-ink-secondary"
    >
      {label}
    </div>
  );
}

export function ErrorState({
  message,
}: {
  readonly message: string;
}): JSX.Element {
  return (
    <div
      role="alert"
      className="rounded-[6px] border border-destructive/35 bg-destructive/10 px-3 py-2 text-xs text-destructive"
    >
      {message}
    </div>
  );
}

export function Empty({ label }: { readonly label: string }): JSX.Element {
  return (
    <p className="px-1 py-2 text-xs text-ink-tertiary">{label}</p>
  );
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Force en-US so timestamps read in English regardless of OS locale
  // (display-only; matches the sidebar date locale).
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US");
}
