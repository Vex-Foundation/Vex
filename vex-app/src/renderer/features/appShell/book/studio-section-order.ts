/**
 * THE STUDIO BOOK RAIL'S SECTION ORDER - what a stored order means when the
 * shell is in Studio mode with a project selected.
 *
 * ONE VOCABULARY, TWO ARRANGEMENTS. The Studio project rail is the SAME rail
 * as the agent session rail (owner parity decree, 2026-09-04), so the ids and
 * the labels are the agent registry's own (`section-order.ts`) and this module
 * invents none. The earlier ratified-v1 decision - a separate `portfolio` id
 * and a deliberately smaller Studio rail - is REVERSED by that decree; a
 * stored order still carrying the retired `portfolio` id degrades through the
 * shared resolver like any other unknown id.
 *
 * What stays this rail's own is the PERSISTED KEY (`studioBookSectionOrder`,
 * whitelist v15). The user's Studio arrangement and their agent arrangement
 * are separate preferences: one key would make reordering one rail reorder the
 * other, and the two rails do not even hold the same cards.
 *
 * The id set here is therefore a PROJECTION, not a copy: the sections that
 * `BOOK_SECTION_SCOPES` says have a real project-scoped read. That projection
 * is also the drop validator, so a session-only id that reached this key -
 * from a hand edit, or from a build where the two orders shared a key - is
 * dropped instead of moving a card the Studio rail cannot render.
 *
 * The resolution and move algebra is the shared mechanism in
 * `section-registry.ts` - see that module for the append-at-end contract.
 */

import {
  resolveSectionOrder,
  type SectionRegistry,
} from "./section-registry.js";
import {
  BOOK_SECTION_LABEL,
  bookSectionsForScope,
  isBookSectionId,
  type BookSectionId,
} from "./section-order.js";

/**
 * The BOOK sections the Studio rail can render. Derived from the scope table
 * rather than re-spelled, so a card that gains a project-scoped read appears
 * here by editing ONE row.
 */
export type StudioBookSectionId = BookSectionId;

/** Default order = the agent rail's order, minus the session-only cards. */
export const DEFAULT_STUDIO_BOOK_SECTIONS: readonly StudioBookSectionId[] =
  bookSectionsForScope("project");

/**
 * Name used by the drag handle's accessible label and the live announcement -
 * the SAME label table both rails read, so one card is never called two names.
 */
export const STUDIO_BOOK_SECTION_LABEL: Readonly<
  Record<StudioBookSectionId, string>
> = BOOK_SECTION_LABEL;

/**
 * The Studio rail's drop validator: a known BOOK id that ALSO has a
 * project-scoped read. `isBookSectionId` alone would accept `activity` and
 * move a card this rail cannot draw.
 */
export function isStudioBookSectionId(
  value: string,
): value is StudioBookSectionId {
  return (
    isBookSectionId(value) &&
    (DEFAULT_STUDIO_BOOK_SECTIONS as readonly string[]).includes(value)
  );
}

export const STUDIO_BOOK_SECTION_REGISTRY: SectionRegistry<StudioBookSectionId> =
  {
    defaults: DEFAULT_STUDIO_BOOK_SECTIONS,
    label: STUDIO_BOOK_SECTION_LABEL,
    isId: isStudioBookSectionId,
  };

/** See `resolveSectionOrder` - known ids in stored order, missing appended. */
export function resolveStudioBookSectionOrder(
  stored: readonly string[],
): readonly StudioBookSectionId[] {
  return resolveSectionOrder(stored, STUDIO_BOOK_SECTION_REGISTRY);
}
