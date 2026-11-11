/**
 * Shared presentational primitives for the Memory panel.
 *
 * Extracted from `MemoryPanel.tsx` so each section module stays under the
 * 400-line budget. Panel-local, NOT a generic UI helper. Holds only the
 * primitives used by more than one section: the section head, the filter and
 * the tag classes, the loading, error and empty states, and the date
 * formatter.
 *
 * R3 (docs/design/R3-MINIMAL.md sections 9.6 and 12): sections are hairline
 * ledger groups with a sans 15 / 600 head, a lead, an optional toolbar and
 * hairline rows (`styles/global-css/memory.css`); tags are quiet 20 high
 * frames, never an accent; loading is the hatch and its word over parked
 * cover rows, a failure is the ink callout, an empty section is one muted
 * sentence.
 */

import type { JSX, ReactNode } from "react";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { LoadingWord } from "../../components/ui/cover.js";
import { CoverRows } from "./screens/PageLoading.js";

export const SECTION = "vex-mem-sec";
export const PILL = "vex-mem-tag";

/** The head of a section: the title, an optional count, the lead under it. */
export function SectionHead({
  title,
  count,
  lead,
}: {
  readonly title: string;
  readonly count?: string;
  readonly lead: ReactNode;
}): JSX.Element {
  return (
    <>
      <div className="vex-mem-sec__head">
        <h2 className="vex-mem-sec__title">{title}</h2>
        {count === undefined ? null : <span className="vex-mem-sec__count">{count}</span>}
      </div>
      <p className="vex-mem-sec__lead">{lead}</p>
    </>
  );
}

/**
 * The segmented filter of a section: one key per value, the chosen one on the
 * selection fill (`aria-pressed`). Plain buttons, because a filter changes
 * what the list below shows, not which panel is on screen.
 */
export function FilterKeys<T extends string>({
  options,
  value,
  onChange,
  label,
}: {
  readonly options: ReadonlyArray<{ readonly value: T; readonly label: string }>;
  readonly value: T;
  readonly onChange: (next: T) => void;
  readonly label: string;
}): JSX.Element {
  return (
    <span className="vex-mem-seg" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          aria-pressed={value === option.value}
          data-active={value === option.value}
        >
          {option.label}
        </button>
      ))}
    </span>
  );
}

/**
 * A section's first read, H3's loading (docs/design/H3-DESKTOP.md section
 * 5.6): the stepping hatch and the word, over two parked cover rows on the
 * card ground where the register's rows will stand. One status, named by the
 * word; the covers are decoration.
 */
export function Loading({ label }: { readonly label: string }): JSX.Element {
  return (
    <div role="status" aria-label={label} aria-busy="true" className="vex-mem-loading">
      <LoadingWord word={label} />
      <CoverRows rows={2} />
    </div>
  );
}

export function ErrorState({
  message,
}: {
  readonly message: string;
}): JSX.Element {
  return <ErrorCallout role="alert" compact title={message} />;
}

export function Empty({ label }: { readonly label: string }): JSX.Element {
  return <p className="vex-mem-empty">{label}</p>;
}

export function fmtDate(iso: string): string {
  const d = new Date(iso);
  // Force en-US so timestamps read in English regardless of OS locale
  // (display-only; matches the sidebar date locale).
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("en-US");
}
