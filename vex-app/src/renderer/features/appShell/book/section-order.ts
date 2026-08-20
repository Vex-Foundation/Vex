/**
 * THE BOOK RAIL'S SECTION REGISTRY — what a stored order means.
 *
 * The order is persisted as an ID LIST, never component references, so a
 * renamed component cannot invalidate a saved layout and an id from an older or
 * newer build is simply dropped. It lives in the renderer's Zustand persist
 * whitelist (`stores/uiStore.ts`) because it is COSMETIC — a display
 * preference never crosses IPC into the privileged process,
 * whose storage is for secrets, wallet state and setup truth.
 *
 * Resolution is deliberately TOLERANT: the payload is user-writable
 * localStorage that outlives builds, so anything unrecognised degrades to the
 * default rather than to a blank rail.
 */

export type BookSectionId =
  | "position"
  | "wallets"
  | "balances"
  | "activity"
  | "runtime"
  | "session"
  | "trench";

/** Default order = the rail's decreed render order (Trench = the merged card). */
export const DEFAULT_BOOK_SECTIONS: readonly BookSectionId[] = [
  "position",
  "wallets",
  "balances",
  "activity",
  "runtime",
  "session",
  "trench",
];

/** Name used by the drag handle's accessible label and the live announcement. */
export const BOOK_SECTION_LABEL: Readonly<Record<BookSectionId, string>> = {
  position: "Position",
  wallets: "Wallets",
  balances: "Balances",
  activity: "Activity",
  runtime: "Runtime & Cost",
  session: "Session",
  trench: "Trench Express",
};

/** Where a drop lands relative to the row under the pointer. */
export type DropEdge = "before" | "after";

export function isBookSectionId(value: string): value is BookSectionId {
  return (DEFAULT_BOOK_SECTIONS as readonly string[]).includes(value);
}

/**
 * Stored order → render order.
 *   1. known ids from `stored`, in STORED order, de-duplicated;
 *   2. then every known id NOT in `stored`, in DEFAULT_BOOK_SECTIONS order,
 *      APPENDED AT THE END.
 * Unknown ids are dropped. `[]` yields DEFAULT_BOOK_SECTIONS unchanged.
 *
 * Append-at-end (not "restore its default slot") is deliberate: once the user
 * has reordered the rail there is no meaningful default slot left to restore a
 * new section into, and guessing one would silently move a section the user
 * placed by hand. A new section arriving at the bottom is visible and undoable.
 */
export function resolveBookSectionOrder(
  stored: readonly string[],
): readonly BookSectionId[] {
  const seen = new Set<BookSectionId>();
  const resolved: BookSectionId[] = [];
  for (const value of stored) {
    if (!isBookSectionId(value) || seen.has(value)) continue;
    seen.add(value);
    resolved.push(value);
  }
  for (const id of DEFAULT_BOOK_SECTIONS) {
    if (!seen.has(id)) resolved.push(id);
  }
  return resolved;
}

/** Move `id` to `toIndex`, bounds-clamped. Never mutates its input. */
export function moveSection(
  order: readonly BookSectionId[],
  id: BookSectionId,
  toIndex: number,
): readonly BookSectionId[] {
  const from = order.indexOf(id);
  if (from === -1) return order;
  const rest = order.filter((entry) => entry !== id);
  const target = Math.min(Math.max(toIndex, 0), rest.length);
  return [...rest.slice(0, target), id, ...rest.slice(target)];
}

/**
 * Move `draggedId` to sit immediately before/after `targetId`. The source is
 * removed BEFORE the insertion point is computed, so no index adjustment is
 * needed at the call site. A self-drop, or an id absent from `order`, is a
 * no-op returning the input unchanged.
 */
export function moveSectionRelative(
  order: readonly BookSectionId[],
  draggedId: BookSectionId,
  targetId: BookSectionId,
  edge: DropEdge,
): readonly BookSectionId[] {
  if (draggedId === targetId) return order;
  if (!order.includes(draggedId) || !order.includes(targetId)) return order;
  const rest = order.filter((entry) => entry !== draggedId);
  const at = rest.indexOf(targetId);
  const target = edge === "before" ? at : at + 1;
  return [...rest.slice(0, target), draggedId, ...rest.slice(target)];
}
