/**
 * THE ONE TOTAL ORDER over a directory's children, and the cursor that names a
 * position in it.
 *
 * The order is a CONTRACT, not a presentation preference. A cursor is a
 * position in an order, so producer and consumer must agree on the comparator
 * or page two silently repeats or skips rows. That is why the sort lives in
 * MAIN, beside pagination, rather than in the tree component: a renderer that
 * re-sorted the rows it received would be sorting a page of somebody else's
 * order.
 *
 * ## The comparator, in three stages
 *
 *  1. DIRECTORIES FIRST. Explorer convention, and the one people notice
 *     immediately when it is missing. Symlinks and other entries sort with
 *     files: a link is shown, not entered, so it belongs with the leaves.
 *  2. NUMERIC-AWARE COLLATION. `Intl.Collator` with `numeric: true`, which is
 *     what VS Code's `compareFileNamesDefault` uses. Without it `file10`
 *     sorts before `file2`, which is wrong in the only way users complain
 *     about.
 *  3. AN EXACT BYTE TIEBREAK. The collator is deliberately case-insensitive
 *     (`sensitivity: "base"`), so `README` and `readme` collate EQUAL - and
 *     two rows that compare equal have no defined order, which makes a cursor
 *     built on that order ambiguous exactly when a directory contains both.
 *     The tiebreak is a plain code-unit comparison, so the order is total.
 *
 * The collator is created once. `Intl.Collator` construction is not cheap and a
 * per-comparison instance would dominate the sort of a large directory.
 *
 * `undefined` locale, deliberately: the user's own locale is what makes their
 * files sort the way the rest of their desktop sorts them. The cursor stays
 * correct across a locale change because it carries the KEY, not an index -
 * see below.
 */

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

/** The only two ranks the first stage produces. */
export const DIRECTORY_RANK = 0;
export const LEAF_RANK = 1;

export interface SortKey {
  /** `DIRECTORY_RANK` or `LEAF_RANK`. */
  readonly rank: number;
  readonly name: string;
}

export function sortKeyFor(kind: string, name: string): SortKey {
  return { rank: kind === "directory" ? DIRECTORY_RANK : LEAF_RANK, name };
}

/** The total order. Returns a negative, zero or positive number as usual. */
export function compareSortKeys(a: SortKey, b: SortKey): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  const collated = collator.compare(a.name, b.name);
  if (collated !== 0) return collated;
  if (a.name === b.name) return 0;
  return a.name < b.name ? -1 : 1;
}

/**
 * A listing cursor.
 *
 * It carries the SORT KEY of the last row already delivered, plus the node the
 * listing was of, and NOT an offset. An offset into a directory that changed
 * between two pages names a different row; a key names a POSITION IN THE ORDER,
 * so a file created or deleted between pages shifts nothing - the next page is
 * still "everything after this key", which is the honest continuation of what
 * the consumer already has.
 *
 * `nodeId` is in the cursor so a cursor from one directory cannot be replayed
 * into another. That would not be a security hole - both are already
 * authorised - but it would silently produce a page of the wrong directory, and
 * `invalid_cursor` is a far better answer than a confidently wrong one.
 */
interface CursorPayload {
  readonly v: 1;
  readonly n: string;
  readonly r: number;
  readonly k: string;
}

export function encodeCursor(nodeKey: string, key: SortKey): string {
  const payload: CursorPayload = { v: 1, n: nodeKey, r: key.rank, k: key.name };
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

/** `null` for anything that is not a cursor this module issued for this node. */
export function decodeCursor(nodeKey: string, cursor: string): SortKey | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<CursorPayload>;
  if (candidate.v !== 1) return null;
  if (candidate.n !== nodeKey) return null;
  if (typeof candidate.r !== "number" || typeof candidate.k !== "string") return null;
  if (candidate.r !== DIRECTORY_RANK && candidate.r !== LEAF_RANK) return null;
  return { rank: candidate.r, name: candidate.k };
}
