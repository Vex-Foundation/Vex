/**
 * THE BOOK RAIL'S SECTION MECHANISM - the pure algebra every rail registry
 * shares, with no opinion about which sections exist.
 *
 * The BOOK has TWO registries now: the agent rail (`section-order.ts`:
 * Position / Wallets / Balances / Activity / Session / Launchpad) and the Studio
 * rail (`studio-section-order.ts`: Portfolio Overview / Wallets / Balances).
 * They evolve INDEPENDENTLY - the ratified Studio v1 list deliberately omits
 * the agent-only cards, and either side can gain a card without the other -
 * so their ids, labels, defaults and stored keys stay in separate modules.
 *
 * What is shared is not the content but the CONTRACT for a stored order:
 * resolution is tolerant in exactly one documented way, and a move is
 * expressed by identity rather than index arithmetic. Those are one invariant
 * with one right answer, so they live here once. A second hand-written copy of
 * `resolveSectionOrder` would be a second place for the append-at-end rule to
 * drift, on a payload that survives builds.
 */

/** Where a drop lands relative to the row under the pointer. */
export type DropEdge = "before" | "after";

/**
 * What a rail must declare about its own sections: the ids it knows, the
 * default render order, the human name each id wears in the drag handle's
 * accessible label and the live announcement.
 */
export interface SectionRegistry<Id extends string> {
  readonly defaults: readonly Id[];
  readonly label: Readonly<Record<Id, string>>;
  /** Type guard over the ids THIS rail knows - never a shared id list. */
  readonly isId: (value: string) => value is Id;
}

/**
 * Stored order -> render order.
 *   1. known ids from `stored`, in STORED order, de-duplicated;
 *   2. then every known id NOT in `stored`, in `defaults` order, APPENDED AT
 *      THE END.
 * Unknown ids are dropped. `[]` yields `defaults` unchanged.
 *
 * Append-at-end (not "restore its default slot") is deliberate: once the user
 * has reordered the rail there is no meaningful default slot left to restore a
 * new section into, and guessing one would silently move a section the user
 * placed by hand. A new section arriving at the bottom is visible and undoable.
 *
 * Resolution is deliberately TOLERANT: the payload is user-writable
 * localStorage that outlives builds, so anything unrecognised degrades to the
 * default rather than to a blank rail.
 */
export function resolveSectionOrder<Id extends string>(
  stored: readonly string[],
  registry: SectionRegistry<Id>,
): readonly Id[] {
  const seen = new Set<Id>();
  const resolved: Id[] = [];
  for (const value of stored) {
    if (!registry.isId(value) || seen.has(value)) continue;
    seen.add(value);
    resolved.push(value);
  }
  for (const id of registry.defaults) {
    if (!seen.has(id)) resolved.push(id);
  }
  return resolved;
}

/** Move `id` to `toIndex`, bounds-clamped. Never mutates its input. */
export function moveSection<Id extends string>(
  order: readonly Id[],
  id: Id,
  toIndex: number,
): readonly Id[] {
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
export function moveSectionRelative<Id extends string>(
  order: readonly Id[],
  draggedId: Id,
  targetId: Id,
  edge: DropEdge,
): readonly Id[] {
  if (draggedId === targetId) return order;
  if (!order.includes(draggedId) || !order.includes(targetId)) return order;
  const rest = order.filter((entry) => entry !== draggedId);
  const at = rest.indexOf(targetId);
  const target = edge === "before" ? at : at + 1;
  return [...rest.slice(0, target), draggedId, ...rest.slice(target)];
}
