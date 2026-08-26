/**
 * BOARD NOTES - the agent's analysis lines.
 *
 * Notes are the ONE board field where newlines are legal, so they are
 * rendered with `whitespace-pre-wrap` to keep the agent's line breaks. They
 * are plain text, never markdown and never HTML: a note is model-authored
 * content, and interpreting markup in it would turn the agent into an author
 * of the reader's DOM.
 *
 * Bounded by the spec (at most 6 notes, 280 characters each), so every note
 * is shown in full - there is no cap here to hide anything behind.
 */

import type { JSX } from "react";

export interface BoardNotesProps {
  readonly notes: readonly string[];
}

export function BoardNotes({ notes }: BoardNotesProps): JSX.Element | null {
  if (notes.length === 0) return null;
  return (
    <ul
      data-vex-area="board-notes"
      data-count={notes.length}
      aria-label="Board notes"
      className="flex flex-col gap-2 rounded-lg border border-line-2 bg-surface-1 p-2.5"
    >
      {notes.map((note, index) => (
        <li
          // Notes have no identity of their own and are not reordered, so the
          // index plus the text is the stable key.
          key={`${index}/${note}`}
          className="whitespace-pre-wrap break-words border-l-2 border-line-2 pl-2.5 text-[12px] leading-relaxed text-ink-secondary"
        >
          {note}
        </li>
      ))}
    </ul>
  );
}
