/**
 * THE STUDIO BOOK RAIL'S SECTION REGISTRY - what a stored order means when the
 * shell is in Studio mode with a project selected.
 *
 * Its OWN registry, not a filtered view of the agent rail's (ratified decision
 * 5): the Studio v1 rail is Portfolio Overview / Wallets / Balances, and the
 * agent-only cards - Session, Activity, Trench, and the Board tab - do not
 * appear in Studio at all. Two ids happen to be spelled the same as agent ids
 * ("wallets", "balances"), which is exactly why the two id SETS must not share
 * a validator: a drop payload of "position" is a known id on one rail and an
 * unknown one on the other, and a shared guard would move the wrong card.
 *
 * Its own PERSISTED KEY too (`studioBookSectionOrder`, whitelist v15). The
 * user's Studio arrangement and their agent arrangement are separate
 * preferences; one key would make reordering one rail reorder the other, and a
 * later divergence in the id sets would silently drop the other rail's order.
 *
 * The resolution and move algebra is the shared mechanism in
 * `section-registry.ts` - see that module for the append-at-end contract.
 */

import {
  resolveSectionOrder,
  type SectionRegistry,
} from "./section-registry.js";

export type StudioBookSectionId = "portfolio" | "wallets" | "balances";

/** Default order = the ratified Studio v1 rail, top to bottom. */
export const DEFAULT_STUDIO_BOOK_SECTIONS: readonly StudioBookSectionId[] = [
  "portfolio",
  "wallets",
  "balances",
];

/** Name used by the drag handle's accessible label and the live announcement. */
export const STUDIO_BOOK_SECTION_LABEL: Readonly<
  Record<StudioBookSectionId, string>
> = {
  portfolio: "Portfolio Overview",
  wallets: "Wallets",
  balances: "Balances",
};

export function isStudioBookSectionId(
  value: string,
): value is StudioBookSectionId {
  return (DEFAULT_STUDIO_BOOK_SECTIONS as readonly string[]).includes(value);
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
