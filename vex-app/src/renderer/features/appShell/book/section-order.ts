/**
 * THE PORTFOLIO PAGE'S SECTION REGISTRY: what a stored order means for the
 * page's reorderable sections (docs/design/R3-MINIMAL.md section 9.1).
 *
 * The order is persisted as an ID LIST, never component references, so a
 * renamed component cannot invalidate a saved layout and an id from an older or
 * newer build is simply dropped. It lives in the renderer's Zustand persist
 * whitelist (`stores/uiStore.ts`, `bookSectionOrder`) because it is COSMETIC:
 * a display preference never crosses IPC into the privileged process, whose
 * storage is for secrets, wallet state and setup truth.
 *
 * The page's total sits above the sections and does not move. Every section
 * answers for every page scope (each one reads the scope it is handed, see
 * `portfolio-page-scope.ts`), so there is one list and no per-scope table.
 *
 * Ids the old side panel stored and the page no longer has degrade cleanly:
 * `position` (now the page's total), `session` and `project` (their facts live
 * in the title bar, the composer and the Vex sidebar's "This project" block),
 * and the long retired `runtime` are all dropped by `resolveBookSectionOrder`.
 * `lighter` is new; an order saved before it existed gets it appended at the
 * end (the shared append-at-end rule), visible and movable. The RESOLUTION
 * and MOVE algebra stays in `section-registry.ts`.
 */

import {
  resolveSectionOrder,
  type SectionRegistry,
} from "./section-registry.js";

export type BookSectionId =
  | "wallets"
  | "balances"
  | "lighter"
  | "activity"
  | "launchpads";

/**
 * Default order = the design's: the Wallets and Balances band, the Lighter
 * account (not in the total), Activity, then the Launchpad (the merged image
 * locker and launch section).
 */
export const DEFAULT_BOOK_SECTIONS: readonly BookSectionId[] = [
  "wallets",
  "balances",
  "lighter",
  "activity",
  "launchpads",
];

/** Name used by the drag handle's accessible label and the live announcement. */
export const BOOK_SECTION_LABEL: Readonly<Record<BookSectionId, string>> = {
  wallets: "Wallets",
  balances: "Balances",
  lighter: "Lighter account",
  activity: "Activity",
  launchpads: "Launchpad",
};

export function isBookSectionId(value: string): value is BookSectionId {
  return (DEFAULT_BOOK_SECTIONS as readonly string[]).includes(value);
}

/** The page's registry, as the shared mechanism and the rows consume it. */
export const BOOK_SECTION_REGISTRY: SectionRegistry<BookSectionId> = {
  defaults: DEFAULT_BOOK_SECTIONS,
  label: BOOK_SECTION_LABEL,
  isId: isBookSectionId,
};

/** See `resolveSectionOrder`: known ids in stored order, missing appended. */
export function resolveBookSectionOrder(
  stored: readonly string[],
): readonly BookSectionId[] {
  return resolveSectionOrder(stored, BOOK_SECTION_REGISTRY);
}

/** Where a section sits in the page's two column band, if it does. */
export type BookSectionBand = "start" | "end";

/**
 * The band (section 9.1: Wallets 1fr beside Balances 1.35fr, 40px apart): it
 * forms wherever the user's order puts Wallets and Balances next to each
 * other, in either order; anywhere else each section spans the page. Returns
 * the band slot per id (absent = full width).
 */
export function bookSectionBands(
  order: readonly BookSectionId[],
): ReadonlyMap<BookSectionId, BookSectionBand> {
  const bands = new Map<BookSectionId, BookSectionBand>();
  for (let index = 0; index < order.length - 1; index += 1) {
    const first = order[index];
    const second = order[index + 1];
    if (first === undefined || second === undefined) continue;
    const pair = new Set([first, second]);
    if (pair.has("wallets") && pair.has("balances")) {
      bands.set(first, "start");
      bands.set(second, "end");
      break;
    }
  }
  return bands;
}
