/**
 * A page's first read, in its own shape (docs/design/H3-DESKTOP.md sections
 * 1.9 and 5.6; VEX Cloud's `PageLoading` and `RowsSkeleton`): the loading
 * word (the stepping hatch and the sentence) over parked covers where the
 * figures and rows will stand. Never a pulse, never a sweep, never a figure.
 *
 *   PageLoading   the one status of the page's first read, named by its
 *                 words and busy; its shapes are decoration. `wordInBar`
 *                 hides the word here when the page's tabs row already says
 *                 it in the stamp's slot (Portfolio, as Cloud's
 *                 `.vx-pfo-loading`).
 *   CoverRows     rows of covers on the card ground in one rule frame: each
 *                 row two text covers (three fifths and four fifths) and a
 *                 short figure cover at the right.
 *
 * Styles: `.vex-pgload` and `.vex-load-rows` in `book.css`.
 */

import type { JSX, ReactNode } from "react";
import { Cover, CoverText, LoadingWord } from "../../../components/ui/cover.js";

export function PageLoading({
  label,
  wordInBar = false,
  children,
}: {
  /** "Loading your portfolio…": the status's name and its visible word. */
  readonly label: string;
  /** The tabs row says the word; the body keeps only its shapes. */
  readonly wordInBar?: boolean;
  /** The covers, each decoration. */
  readonly children?: ReactNode;
}): JSX.Element {
  return (
    <div
      role="status"
      aria-label={label}
      aria-busy="true"
      className="vex-pgload"
      data-word-in-bar={wordInBar ? "" : undefined}
    >
      <LoadingWord word={label} />
      {children}
    </div>
  );
}

export function CoverRows({ rows }: { readonly rows: number }): JSX.Element {
  return (
    <ul className="vex-load-rows" aria-hidden="true" data-vex-cover-rows={rows}>
      {Array.from({ length: rows }, (_, index) => (
        <li key={index}>
          <span className="vex-load-rows__text">
            <CoverText width="60%" />
            <CoverText width="80%" />
          </span>
          <Cover width="64px" />
        </li>
      ))}
    </ul>
  );
}
