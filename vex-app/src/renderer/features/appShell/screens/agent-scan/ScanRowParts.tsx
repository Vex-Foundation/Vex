/**
 * The parts every ledger row shares (docs/design/R3-MINIMAL.md section 9.2):
 * Agent Scan's two arms and the token history draw one grid, 112 | 1fr | 120
 * | 250, and end in the same place: a state word with its fill and, under it,
 * the consequence in muted type. The grid and its type live in
 * `styles/global-css/overlay.css` (`.vex-scan-*`).
 *
 * THE WORD IS DATA. A row's outcome is decided by the arm's own reader (the
 * activity arm in `agent-scan-outcome.ts`, the token history in
 * `token-history-display.ts`); this file only draws it. Each consequence
 * segment keeps its own element and its own title, so the longer statement a
 * segment stands for ("Repeated checks could not confirm this yet...") stays
 * one hover away and a reader can find the short words by themselves.
 */

import { Fragment, type JSX, type ReactNode } from "react";
import { StateWord } from "../../../../components/ui/state-word.js";
import type { SwatchState } from "../../../../components/ui/swatch.js";

/** One segment of the muted line under a state word. */
export interface ScanOutcomeNote {
  readonly text: string;
  /** The full statement the short words stand for, on hover. */
  readonly title?: string | undefined;
}

/** How a ledger row ends: the fill, the word, the consequence. */
export interface ScanOutcome {
  readonly state: SwatchState;
  readonly word: string;
  readonly notes: readonly ScanOutcomeNote[];
}

/** The right-hand cell: the state word, then its consequence. */
export function ScanState({ outcome }: { readonly outcome: ScanOutcome }): JSX.Element {
  return (
    <span className="vex-scan-state" data-vex-scan-state={outcome.word}>
      <StateWord state={outcome.state} word={outcome.word} />
      {outcome.notes.length > 0 ? (
        <span className="vex-scan-sub">
          {outcome.notes.map((note, index) => (
            <Fragment key={note.text}>
              {index > 0 ? <span aria-hidden> · </span> : null}
              <span title={note.title}>{note.text}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
    </span>
  );
}

/** The left-hand cell: the kind in caps (the badge's words, read as text). */
export function ScanKind({ children }: { readonly children: ReactNode }): JSX.Element {
  return <span className="vex-scan-kind">{children}</span>;
}

/**
 * The meta line's text segments, dot-separated. Each keeps its own element so
 * a route or a time can be read (and found) on its own.
 */
export function ScanMeta({
  parts,
  children,
}: {
  readonly parts: readonly { readonly key: string; readonly text: string; readonly figure?: boolean }[];
  /** The row's links, after the text. */
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <span className="vex-scan-meta">
      {parts.length > 0 ? (
        <span className="vex-scan-meta__text">
          {parts.map((part, index) => (
            <Fragment key={part.key}>
              {index > 0 ? <span aria-hidden> · </span> : null}
              <span className={part.figure === true ? "vex-num" : undefined}>{part.text}</span>
            </Fragment>
          ))}
        </span>
      ) : null}
      {children === undefined || children === null ? null : (
        <span className="vex-scan-links">{children}</span>
      )}
    </span>
  );
}

/**
 * "TX" with its arrow, to a MAIN-RESOLVED explorer URL. The caller passes a
 * URL it already holds from main's allowlist (or built through the shared
 * `explorerTxUrl`); this part never derives one.
 */
export function ScanTxLink({
  href,
  label,
  text = "TX",
}: {
  readonly href: string;
  readonly label: string;
  readonly text?: string;
}): JSX.Element {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={label}
      className="vex-scan-link"
    >
      {text}
      <span aria-hidden className="vex-num">↗</span>
    </a>
  );
}
