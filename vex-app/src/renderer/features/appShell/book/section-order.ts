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
 * SINCE THE STUDIO PARITY DECREE (owner screenshots, 2026-09-04) THIS IS THE
 * ONLY SECTION VOCABULARY THE BOOK HAS. The Studio project rail is the SAME
 * rail as the agent session rail, scoped to the project's wallets, so a second
 * id union would have been a second answer to "which card is this". What the
 * Studio rail still owns alone is its persisted ORDER KEY
 * (`studio-section-order.ts`) - one user, two arrangements.
 *
 * A section is not universal, though: some cards can only be answered for a
 * SESSION, and one only for a PROJECT. `BOOK_SECTION_SCOPES` below is the one
 * table that says which, with the reason, and `bookSectionsForScope` is the
 * only way a rail learns its list. The RESOLUTION and MOVE algebra stays in
 * `section-registry.ts`.
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
  | "project"
  | "launchpads";

/**
 * Default order = the rail's decreed render order (`launchpads` = the merged
 * image-locker + launch card).
 * `session` and `project` share ONE slot: they are the same "what am I
 * looking at" card for the two scopes, and no rail ever renders both.
 */
export const DEFAULT_BOOK_SECTIONS: readonly BookSectionId[] = [
  "position",
  "wallets",
  "balances",
  "activity",
  "session",
  "project",
  "launchpads",
];

/** Name used by the drag handle's accessible label and the live announcement. */
export const BOOK_SECTION_LABEL: Readonly<Record<BookSectionId, string>> = {
  position: "Position",
  wallets: "Wallets",
  balances: "Balances",
  activity: "Activity",
  session: "Session",
  project: "Project",
  launchpads: "Launchpad",
};

export function isBookSectionId(value: string): value is BookSectionId {
  return (DEFAULT_BOOK_SECTIONS as readonly string[]).includes(value);
}

/** The wallet scopes a BOOK rail can be mounted for. */
export type BookRailScopeKind = "session" | "project";

/**
 * WHICH SCOPES EACH SECTION CAN HONESTLY ANSWER FOR - the one table, and the
 * only reason a rail ever renders fewer cards than another.
 *
 * A row lists a scope kind only when the card has a REAL read for it. Nothing
 * here is a taste decision about what Studio "should" show; every omission is
 * a card that would otherwise have to invent an answer, which on a rail that
 * names whose funds are on screen is a wrong answer, not a degraded one.
 *
 *   position  session + project  `usePortfolio` takes the scope union straight
 *                                to the wire; main resolves the wallet
 *                                allow-list for both arms.
 *   wallets   session + project  `WalletPairCard` already reads either.
 *   balances  session + project  `BalancesCard` already reads either.
 *   activity  session + project  `agentScanFiltersSchema` now carries
 *                                `filters.projectId` beside `sessionId`, and
 *                                MAIN resolves that project's own wallets
 *                                from `project_wallets` and INTERSECTS them
 *                                with the inventory allow-list
 *                                (`agent-scan-db.ts`). So the card has a real
 *                                project read and the scope decision stayed
 *                                in main - the renderer still never filters a
 *                                global feed.
 *   session   session ONLY       the card IS the session object (model, turn
 *                                stats, sleep state). A project has none.
 *   project   project ONLY       the project-scoped counterpart of `session`:
 *                                the card IS the project object (access,
 *                                path, created). A session has none.
 *   launchpads session + project the image locker is GLOBAL (`useLockerImages`
 *                                takes no scope), so the card browses it for
 *                                either. Only the LAUNCH is keyed by session
 *                                id on the signing path, and the card renders
 *                                that action for a session alone (see
 *                                `ImageLockerCard`).
 */
export const BOOK_SECTION_SCOPES: Readonly<
  Record<BookSectionId, readonly BookRailScopeKind[]>
> = {
  position: ["session", "project"],
  wallets: ["session", "project"],
  balances: ["session", "project"],
  activity: ["session", "project"],
  session: ["session"],
  project: ["project"],
  launchpads: ["session", "project"],
};

/** Does this section have a real read for `kind`? */
function bookSectionServesScope(
  id: BookSectionId,
  kind: BookRailScopeKind,
): boolean {
  return BOOK_SECTION_SCOPES[id].includes(kind);
}

/**
 * The sections a rail mounted for `kind` renders, in the decreed default
 * order. The ONLY producer of a rail's id list - a surface that hand-wrote its
 * own list would be a second place for the table above to drift.
 */
export function bookSectionsForScope(
  kind: BookRailScopeKind,
): readonly BookSectionId[] {
  return DEFAULT_BOOK_SECTIONS.filter((id) => bookSectionServesScope(id, kind));
}

/**
 * The agent SESSION rail's own list: the vocabulary minus the project-only
 * card. The same projection `studio-section-order.ts` makes for the project
 * rail, so neither rail's registry can yield an id it renders as nothing.
 */
export const SESSION_BOOK_SECTIONS: readonly BookSectionId[] =
  bookSectionsForScope("session");

/**
 * The session rail's drop validator: a known BOOK id that ALSO has a
 * session-scoped read, so a `project` id that reached the agent key is
 * dropped instead of moving an empty section.
 */
export function isSessionBookSectionId(value: string): value is BookSectionId {
  return isBookSectionId(value) && bookSectionServesScope(value, "session");
}

/** The session rail's registry, as the shared mechanism and the rows consume it. */
export const BOOK_SECTION_REGISTRY: SectionRegistry<BookSectionId> = {
  defaults: SESSION_BOOK_SECTIONS,
  label: BOOK_SECTION_LABEL,
  isId: isSessionBookSectionId,
};

/** See `resolveSectionOrder` - known ids in stored order, missing appended. */
export function resolveBookSectionOrder(
  stored: readonly string[],
): readonly BookSectionId[] {
  return resolveSectionOrder(stored, BOOK_SECTION_REGISTRY);
}
