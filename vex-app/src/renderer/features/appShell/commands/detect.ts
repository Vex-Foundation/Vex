/**
 * Slash-command trigger detection (B9). Pure caret scan: a "/" opens the
 * command menu only at the start of a word, with URL carve-outs so slashes
 * inside "https://..." never trigger. Zero React, zero DOM.
 */

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const WHITESPACE = /\s/u;

export interface SlashCommandHit {
  /** Text between the "/" and the caret (the live filter query). */
  readonly query: string;
  /** Index of the "/" in the draft. */
  readonly start: number;
  /** Caret offset (exclusive end of the token under edit). */
  readonly end: number;
}

/**
 * Word-boundary rule: "/" opens only at start-of-draft, after whitespace
 * (newlines included), or after punctuation. Two URL carve-outs keep "/"
 * dead inside URLs: a "/" after a ":" that itself follows a non-whitespace
 * char (scheme separator, `https:/...`), and a "/" directly after another
 * "/" (second slash of `//`).
 */
function boundaryOk(draft: string, index: number): boolean {
  if (index === 0) return true;
  const prev = draft.charAt(index - 1);
  if (WHITESPACE.test(prev)) return true;
  if (WORD_CHAR.test(prev)) return false;
  if (prev === "/") return false;
  if (
    prev === ":" &&
    index >= 2 &&
    !WHITESPACE.test(draft.charAt(index - 2))
  ) {
    return false;
  }
  return true;
}

/**
 * Detect a live slash token at the caret. Scans left from the caret and
 * stops at the first whitespace (the token under edit never spans
 * whitespace); a "/" failing the word boundary is treated as an ordinary
 * token char and the scan continues. Null when no trigger is live.
 */
export function detectSlashCommand(
  draft: string,
  caret: number,
): SlashCommandHit | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = draft.charAt(i);
    if (WHITESPACE.test(ch)) return null;
    if (ch !== "/") continue;
    if (!boundaryOk(draft, i)) continue;
    return { query: draft.slice(i + 1, caret), start: i, end: caret };
  }
  return null;
}
