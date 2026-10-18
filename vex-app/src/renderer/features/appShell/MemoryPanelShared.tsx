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
 * frames, never an accent; loading is a word and a quiet line, a failure is
 * the ink callout, an empty section is one muted sentence.
 */

import type { JSX, ReactNode } from "react";
import { ErrorCallout } from "../../components/ui/error-callout.js";
import { StateWord } from "../../components/ui/state-word.js";

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

export function Loading({ label }: { readonly label: string }): JSX.Element {
  return (
    <div role="status" aria-live="polite" className="vex-mem-loading">
      <StateWord state="listening" word={label} />
      {/* The same line the loader draws; decorative, the word says it. */}
      <span className="vex-loader vex-loader--ink" aria-hidden>
        <i className="vex-loader__segment" />
      </span>
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
