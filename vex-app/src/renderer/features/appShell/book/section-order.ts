/**
 * THE AGENT BOOK RAIL'S SECTION REGISTRY - what a stored order means for the
 * session stage.
 *
 * The order is persisted as an ID LIST, never component references, so a
 * renamed component cannot invalidate a saved layout and an id from an older or
 * newer build is simply dropped. It lives in the renderer's Zustand persist
 * whitelist (`stores/uiStore.ts`) because it is COSMETIC - a display
 * preference never crosses IPC into the privileged process,
 * whose storage is for secrets, wallet state and setup truth.
 *
 * The RESOLUTION and MOVE algebra is shared with the Studio rail
 * (`section-registry.ts`); the ids, labels and default order below are this
 * rail's alone. See that module for why the two registries stay separate.
 */

import {
  resolveSectionOrder,
  type SectionRegistry,
} from "./section-registry.js";

/**
 * `runtime` ("Runtime & Cost") retired in round 3 (owner QA item 1): context
 * occupancy and the access mode moved into the composer, and transcript turn
 * stats remain the cost surface. A stored order that still lists it degrades
 * cleanly - `resolveBookSectionOrder` drops unrecognised ids by design.
 */
export type BookSectionId =
  | "position"
  | "wallets"
  | "balances"
  | "activity"
  | "session"
  | "trench";

/** Default order = the rail's decreed render order (Trench = the merged card). */
export const DEFAULT_BOOK_SECTIONS: readonly BookSectionId[] = [
  "position",
  "wallets",
  "balances",
  "activity",
  "session",
  "trench",
];

/** Name used by the drag handle's accessible label and the live announcement. */
export const BOOK_SECTION_LABEL: Readonly<Record<BookSectionId, string>> = {
  position: "Position",
  wallets: "Wallets",
  balances: "Balances",
  activity: "Activity",
  session: "Session",
  trench: "Trench Express",
};

export function isBookSectionId(value: string): value is BookSectionId {
  return (DEFAULT_BOOK_SECTIONS as readonly string[]).includes(value);
}

/** This rail's registry, as the shared mechanism and the rows consume it. */
export const BOOK_SECTION_REGISTRY: SectionRegistry<BookSectionId> = {
  defaults: DEFAULT_BOOK_SECTIONS,
  label: BOOK_SECTION_LABEL,
  isId: isBookSectionId,
};

/** See `resolveSectionOrder` - known ids in stored order, missing appended. */
export function resolveBookSectionOrder(
  stored: readonly string[],
): readonly BookSectionId[] {
  return resolveSectionOrder(stored, BOOK_SECTION_REGISTRY);
}
