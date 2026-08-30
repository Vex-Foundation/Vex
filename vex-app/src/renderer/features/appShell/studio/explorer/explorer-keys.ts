/**
 * THE KEYBOARD CONTRACT, as a table.
 *
 * Pure: a key event in, an INTENT out, or `null` for "this key is not ours,
 * let it through". The component owns the effects; this owns the mapping, so
 * the contract can be table-tested without a DOM and a new key is one row.
 *
 * Every mapping below is VS Code's, and the two that are easy to get wrong are
 * the arrows (`abstractTree.ts:3166-3234`):
 *
 *  - LEFT collapses an expanded directory; if there was nothing to collapse (a
 *    file, or an already-collapsed directory) it moves focus to the PARENT.
 *  - RIGHT expands a collapsed directory; if there was nothing to expand it
 *    moves focus to the FIRST CHILD. On a file it does nothing at all.
 *
 * One rule spans the whole table and is the reason focus is not selection:
 * MOVING FOCUS NEVER EXPANDS OR LOADS ANYTHING. Arrowing through a tree must
 * not fire a directory listing per row.
 */

/** How long a type-ahead prefix survives after the last keystroke. */
export const EXPLORER_TYPE_AHEAD_RESET_MS = 1_000;

export type ExplorerFocusMove =
  | "previous"
  | "next"
  | "first"
  | "last"
  | "pageUp"
  | "pageDown";

export type ExplorerIntent =
  /** Move the focused row. Never expands, never loads, never opens. */
  | { readonly kind: "moveFocus"; readonly to: ExplorerFocusMove }
  /** Left: collapse, or go to the parent when there was nothing to collapse. */
  | { readonly kind: "collapseOrParent" }
  /** Right: expand, or go to the first child when there was nothing to expand. */
  | { readonly kind: "expandOrFirstChild" }
  /** Enter: toggle a directory, open a file, load a page, retry a notice. */
  | { readonly kind: "activate" }
  /** Space: toggle a directory. Does nothing on a file. */
  | { readonly kind: "toggle" }
  /** A printable character joins the type-ahead prefix. */
  | { readonly kind: "typeAhead"; readonly character: string };

/** The shape this table reads. A `KeyboardEvent` satisfies it structurally. */
export interface ExplorerKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
}

const MOVES: Readonly<Record<string, ExplorerFocusMove>> = {
  ArrowUp: "previous",
  ArrowDown: "next",
  Home: "first",
  End: "last",
  PageUp: "pageUp",
  PageDown: "pageDown",
};

/**
 * Resolve a key press to an intent, or `null` to let it through.
 *
 * A chord (Ctrl, Meta or Alt held) is ALWAYS let through: those belong to the
 * application and the platform, and a tree that swallowed Ctrl+F to type-ahead
 * for "f" would break find. Shift is not in that list because Shift+letter is
 * how a capital is typed, which type-ahead must see.
 */
export function resolveExplorerKey(event: ExplorerKeyEvent): ExplorerIntent | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null;

  const move = MOVES[event.key];
  if (move !== undefined) return { kind: "moveFocus", to: move };

  if (event.key === "ArrowLeft") return { kind: "collapseOrParent" };
  if (event.key === "ArrowRight") return { kind: "expandOrFirstChild" };
  if (event.key === "Enter") return { kind: "activate" };
  if (event.key === " ") return { kind: "toggle" };

  // A single-character `key` is a printable character; every named key
  // ("Tab", "Escape", "F3", "Dead") is longer, which is what makes this test
  // exhaustive without listing the keys we do NOT handle.
  if ([...event.key].length === 1) return { kind: "typeAhead", character: event.key };

  return null;
}

/**
 * Extend a type-ahead prefix.
 *
 * The prefix restarts when more than {@link EXPLORER_TYPE_AHEAD_RESET_MS} has
 * passed since the last keystroke, so a user who types "re", pauses, then types
 * "ad" is looking for "ad" rather than for "read".
 */
export function nextTypeAheadPrefix(
  current: { readonly prefix: string; readonly atMs: number } | null,
  character: string,
  nowMs: number,
): string {
  if (current === null || nowMs - current.atMs > EXPLORER_TYPE_AHEAD_RESET_MS) {
    return character;
  }
  return current.prefix + character;
}

/**
 * The row a type-ahead prefix selects: the next name at or after `fromIndex`
 * that starts with it, WRAPPING to the beginning.
 *
 * `nameAt` is an accessor rather than an array because the tree can hold tens
 * of thousands of rows and a keystroke must not materialise all of them; rows
 * that are not filesystem entries answer `null` and are skipped.
 *
 * Search starts one past the current row, so repeating a letter walks through
 * the matches - what every file tree does, and what a user pressing "s" three
 * times expects. Case-insensitive: someone typing a filename is not thinking
 * about its case.
 */
export function findTypeAheadIndex(
  count: number,
  nameAt: (index: number) => string | null,
  fromIndex: number,
  prefix: string,
): number {
  if (prefix === "" || count === 0) return -1;
  const needle = prefix.toLowerCase();
  const start = fromIndex < 0 || fromIndex >= count ? 0 : fromIndex;

  // A prefix that GREW (the user is still typing one word) keeps the current
  // row when it still matches, rather than jumping on to the next match.
  const current = nameAt(start);
  if (prefix.length > 1 && current !== null && current.toLowerCase().startsWith(needle)) {
    return start;
  }
  for (let step = 1; step <= count; step += 1) {
    const index = (start + step) % count;
    const name = nameAt(index);
    if (name !== null && name.toLowerCase().startsWith(needle)) return index;
  }
  return -1;
}
