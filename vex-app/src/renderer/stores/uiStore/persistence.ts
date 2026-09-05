/**
 * uiStore persistence: the partialize whitelist, expand-only version
 * migrations, and the every-rehydrate merge coercion for the user-writable
 * localStorage payload. Every whitelisted key is coerced on the way in - being
 * on the whitelist makes a key persistable, not trustworthy. Extracted from uiStore.ts so the store file stays a
 * readable slot registry.
 */

import type { BookTab, UiState } from "../uiStore.js";
import {
  coerceThemePreference,
  resolveTheme,
  systemPrefersDark,
  type VexTheme,
} from "./theme.js";
import { coerceRuntimeMode, DEFAULT_RUNTIME_MODE } from "./runtime-mode.js";
import {
  coerceBookWidth,
  coerceSidebarWidth,
  coerceStudioRailExplorerShare,
  STUDIO_RAIL_EXPLORER_SHARE_DEFAULT,
} from "./layout.js";
import { coerceStudioFileTabs } from "./studio-file-tabs.js";

/** Hard bounds on the persisted BOOK rail order (user-writable localStorage). */
const MAX_BOOK_SECTION_ENTRIES = 32;
const MAX_BOOK_SECTION_ID_LENGTH = 32;
/** Hard bound on the persisted Studio project id, as the schemas bound it. */
const MAX_PROJECT_ID_LENGTH = 64;

/**
 * THE persisted-field list. One source of truth for BOTH directions.
 *
 * `partializeUiState` writes exactly these keys and `mergeUiState` reads
 * exactly these keys, so the two cannot drift. Before this list existed the
 * merge spread the whole user-writable payload over the live state, which meant
 * a hand-edited `vex-ui` object could inject ANY slot the store declares -
 * `runtimeMode`, `activeProjectId`, `currentView`, `activeSessionId` - and the
 * store would rehydrate straight into it. localStorage is untrusted input, and
 * a write-side whitelist alone never made the read side safe.
 *
 * Adding a slot here is the ONLY way to make it persist. A slot that is absent
 * is ephemeral in both directions by construction.
 *
 * ## `runtimeMode` and `activeProjectId` ARE on the list, and why that is safe
 *
 * They used to be the named example above of what must never come back from
 * storage, and the reason was correct as stated: the merge used to spread the
 * whole payload, so ANY slot could be injected into, unvalidated. That is what
 * the whitelist plus the per-key coercion below answers. Studio's welcome copy
 * promises "Studio is where you left it when you come back", and a mode plus a
 * project id are exactly the LAST LOCATION that promise is about.
 *
 * Both are validated rather than trusted, in two stages:
 *
 *  - here, on the way in: the mode is narrowed to its closed union
 *    (`coerceRuntimeMode`) and the id to a bounded plain string
 *    (`coerceActiveProjectId`). Nothing else can reach either slot.
 *  - and by EXISTENCE, in `StudioCenter`'s stale-selection repair, which runs
 *    against a SETTLED project list and gives up a selection naming a project
 *    that is not in it. So a hand-written or stale id opens nothing: Studio
 *    falls back to the welcome, in Studio mode, with the recents.
 *
 * That two-stage shape is VS Code's own window restore rather than an
 * invention: the last workspace path is stored, and
 * `workspacesHistoryMainService` validates every remembered entry against the
 * filesystem before it is offered or opened. A remembered location is a HINT
 * that must survive being wrong; it is never an authority, and it grants
 * nothing - opening a project goes through the same IPC, the same capability
 * checks and the same main-side validation as a click on the rail.
 */
export const PERSISTED_UI_KEYS = [
  "runtimeMode",
  "activeProjectId",
  "themePreference",
  "sidebarOpen",
  "bookOpen",
  "sidebarWidth",
  "bookWidth",
  "hideDustBalances",
  "notificationsEnabled",
  "bookSectionOrder",
  "studioBookSectionOrder",
  "bookTab",
  "studioRailExplorerShare",
  "studioFileTabs",
] as const satisfies readonly (keyof UiState)[];

export type PersistedUiKey = (typeof PERSISTED_UI_KEYS)[number];

export function partializeUiState(state: UiState): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of PERSISTED_UI_KEYS) payload[key] = state[key];
  return payload;
}

/**
 * A persisted rail SECTION ORDER, coerced from user-writable storage.
 *
 * HARD BOUND on both the list and each entry so a hand-written payload cannot
 * make a resolver walk an unbounded array. Anything off-shape degrades to []
 * - the default order, never a crash and never a blank rail. Both rails
 * (`bookSectionOrder`, `studioBookSectionOrder`) read through this one
 * function so their bounds cannot drift.
 */
function coerceSectionOrder(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  if (value.length > MAX_BOOK_SECTION_ENTRIES) return [];
  const entries: string[] = [];
  for (const entry of value) {
    if (
      typeof entry !== "string" ||
      entry.length === 0 ||
      entry.length > MAX_BOOK_SECTION_ID_LENGTH
    ) {
      return [];
    }
    entries.push(entry);
  }
  return entries;
}

/**
 * THE LAST STUDIO PROJECT, coerced from user-writable storage.
 *
 * Bounded exactly as every project id is bounded at the process boundary
 * (`z.string().min(1).max(64)` in the projects and terminal schemas), so a
 * payload cannot make a downstream reader carry an unbounded string. Anything
 * that is not such a string - a number, an object, an empty or over-long
 * string, an absent key - degrades to `null`, which is the welcome screen.
 *
 * A value that PASSES here is still only a candidate: `StudioCenter` drops it
 * when the settled project list does not contain it. See the whitelist note.
 */
export function coerceActiveProjectId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  if (value.length === 0 || value.length > MAX_PROJECT_ID_LENGTH) return null;
  return value;
}

/**
 * The BOOK's selected tab, coerced from user-writable storage.
 *
 * Anything that is not exactly `"board"` degrades to `"portfolio"`, the
 * default a fresh install gets.
 */
export function coerceBookTab(value: unknown): BookTab {
  return value === "board" ? "board" : "portfolio";
}

// Expand-only migrations, oldest first:
//   v2: BOOK now opens by default — force it open once on upgrade from v1
//       so existing installs pick up the new default (later toggles
//       persist normally).
//   v3: `theme` added — seed the then-default so a pre-theme install
//       hydrates into a defined value, not `undefined`.
//   v4: `hlFavorites` added, then removed by the Hyperliquid deletion: a
//       leftover key in an old payload is simply ignored by merge below.
//   v5: Chronos rebrand — the retired `vex`/`robinhood` theme pair collapses
//       to `chronos` (the merge coercion also enforces this on rehydrate).
//   v6: `hideDustBalances` added (Portfolio tab dust filter) — seed TRUE,
//       the same default a fresh install gets.
//   v7: `prologueVersion` added (gate-prologue play policy), later removed
//       in v12 — an old payload's key is dropped there.
//   v8: `bookSectionOrder` added (BOOK rail drag-to-reorder) — seed [].
//   v9: `theme` became `themePreference` — seed through the coercion.
//   v10: `sidebarWidth`/`bookWidth` added (shell column drag) — seed the
//       contract defaults so an upgrading install hydrates into defined
//       widths, not `undefined`.
//   v11: `notificationsEnabled` added (A34 native turn notification) - seed
//       TRUE, the same default a fresh install gets.
//   v12: `prologueVersion` removed (the gate-prologue play policy retired
//       with the orb cluster) - drop the stale key from old payloads.
//   v13: the default preference became `system` (ratified 2026-08-21 - with
//       no explicit choice every screen follows the OS). This is a ONE-TIME
//       re-default of the SEEDED value: `chronos` was not a choice on most
//       installs, it was the old default written by the v5/v9 hops and by
//       the store's own initial state, and there is no record separating
//       the two. A user who deliberately wants chronos re-picks it in
//       Settings; that choice persists and v13 never runs again. An
//       explicit `celeris` or `system` is left untouched.
//   v14: `bookTab` added (the BOOK's Portfolio | Board tabs) - seed
//       `portfolio`, the same default a fresh install gets. The tab is a rail
//       preference like `bookOpen`: the user picks it, and nothing in the
//       product ever writes it programmatically.
//   v15: `studioBookSectionOrder` added (the Studio rail's OWN section order).
//       It cannot share `bookSectionOrder`'s key: the two registries have
//       different id sets, so each rail's resolver would drop the other's
//       ids. Seed [] - the same "no custom order, use the default" a fresh
//       install gets. Expand-only like every hop above: an older payload
//       gains the key, nothing is rewritten.
//   v17: `runtimeMode` and `activeProjectId` added - the LAST STUDIO LOCATION,
//       so a relaunch returns to the project the user left open instead of the
//       Agent welcome. Expand-only like every hop above: an older payload
//       gains the two keys seeded with the values a fresh install has (agent
//       mode, no project), and nothing already stored is rewritten. A reader
//       from before this hop simply ignores two keys it does not whitelist,
//       which is what makes the rollout reader-before-writer safe within one
//       deploy.
//   v18: `studioFileTabs` added - the OPEN FILE TABS' own persisted home, per
//       project. The terminal snapshot deliberately carries no file tab
//       (`toPersistedLayout`) and its restore channel answers null for a
//       project with no live terminal, so a file-only workspace could never
//       come back through it; VS Code keeps editor state in workbench storage
//       for the same reason. Seed `{}` - no remembered tabs, which is what a
//       fresh install has. Expand-only like every hop above, and a reader from
//       before it simply ignores a key it does not whitelist.
//   v19: the BOOK rail's `trench` section id RENAMED to `launchpads`. Migration
//       108 retired Trench Express; the card it names is the image locker plus
//       the launch action, which survives on pools.fun. The stored arrays are
//       rewritten rather than left to `resolveBookSectionOrder`'s
//       drop-unrecognised rule, which would have silently discarded the user's
//       own arrangement of a card that is still there. The FIRST hop that
//       rewrites rather than seeds, which is why it is spelled out.
//   v16: `studioRailExplorerShare` added (the Studio rail's vertical split
//       between the PROJECTS list and the EXPLORER pane, which used to be a
//       fixed 256px box). Seed the default so an upgrading install hydrates
//       into a defined share rather than `undefined`.
export function migrateUiState(persisted: unknown, version: number): unknown {
  if (persisted === null || typeof persisted !== "object") {
    return persisted;
  }
  let next = persisted as Record<string, unknown>;
  if (version < 2) next = { ...next, bookOpen: true };
  if (version < 5) next = { ...next, theme: "chronos" };
  if (version < 6 && !("hideDustBalances" in next)) {
    next = { ...next, hideDustBalances: true };
  }
  if (version < 8 && !("bookSectionOrder" in next)) {
    next = { ...next, bookSectionOrder: [] };
  }
  if (version < 9) {
    next = { ...next, themePreference: coerceThemePreference(next["theme"]) };
  }
  if (version < 10) {
    next = {
      ...next,
      sidebarWidth: coerceSidebarWidth(next["sidebarWidth"]),
      bookWidth: coerceBookWidth(next["bookWidth"]),
    };
  }
  if (version < 11 && !("notificationsEnabled" in next)) {
    next = { ...next, notificationsEnabled: true };
  }
  if (version < 12 && "prologueVersion" in next) {
    const { prologueVersion: _dropped, ...rest } = next;
    next = rest;
  }
  if (version < 13 && next["themePreference"] === "chronos") {
    next = { ...next, themePreference: "system" };
  }
  if (version < 14 && !("bookTab" in next)) {
    next = { ...next, bookTab: "portfolio" };
  }
  if (version < 15 && !("studioBookSectionOrder" in next)) {
    next = { ...next, studioBookSectionOrder: [] };
  }
  if (version < 16 && !("studioRailExplorerShare" in next)) {
    next = {
      ...next,
      studioRailExplorerShare: STUDIO_RAIL_EXPLORER_SHARE_DEFAULT,
    };
  }
  if (version < 17 && !("runtimeMode" in next)) {
    next = {
      ...next,
      runtimeMode: DEFAULT_RUNTIME_MODE,
      activeProjectId: null,
    };
  }
  if (version < 18 && !("studioFileTabs" in next)) {
    next = { ...next, studioFileTabs: {} };
  }
  if (version < 19) {
    next = {
      ...next,
      bookSectionOrder: renameRetiredTrenchSection(next["bookSectionOrder"]),
      studioBookSectionOrder: renameRetiredTrenchSection(
        next["studioBookSectionOrder"],
      ),
    };
  }
  return next;
}

/**
 * v19's rename, applied to one stored order.
 *
 * A RENAME, not a drop. `resolveBookSectionOrder` discards ids it does not
 * recognise, so leaving `"trench"` in a stored array would silently delete that
 * user's arrangement of the card - the card itself did not go anywhere, only
 * its name did. A non-array or a non-string member degrades to being left
 * alone here and is coerced by `coerceSectionOrder` on the way in, so this hop
 * never has to be the input validator as well.
 */
function renameRetiredTrenchSection(stored: unknown): unknown {
  if (!Array.isArray(stored)) return stored;
  return stored.map((id) => (id === "trench" ? "launchpads" : id));
}

// localStorage is user-writable (untrusted input), and `migrate` only runs on
// version hops — a hand-edited current-version payload skips it. Coerce on
// EVERY rehydrate: any off-shape value degrades to its default instead of
// reaching the DOM or the solver.
export function mergeUiState(persisted: unknown, current: UiState): UiState {
  const incoming =
    persisted !== null && typeof persisted === "object"
      ? (persisted as Partial<UiState>)
      : undefined;
  const themePreference = coerceThemePreference(incoming?.themePreference);
  const theme: VexTheme = resolveTheme(themePreference, systemPrefersDark());
  // Anything non-boolean degrades to the TRUE default, never a crash or a
  // stray non-boolean reaching the checkbox's `checked` prop.
  const hideDustBalances: boolean =
    typeof incoming?.hideDustBalances === "boolean"
      ? incoming.hideDustBalances
      : true;
  // Same TRUE-default coercion as dust: a hand-edited non-boolean can never
  // reach the notify call path.
  const notificationsEnabled: boolean =
    typeof incoming?.notificationsEnabled === "boolean"
      ? incoming.notificationsEnabled
      : true;
  // The two RAIL booleans came back through the whitelist RAW: `sidebarOpen`
  // and `bookOpen` are declared persisted keys, so a hand-edited `"yes"` used
  // to land straight in the slot and reach the column solver and the rails'
  // `hidden`/width props as a non-boolean. Same coercion as dust above, with
  // the STORE-CONSTRUCTED default as the fallback rather than a literal, so
  // this file never becomes a second place the shell's opening state is
  // declared.
  const sidebarOpen: boolean =
    typeof incoming?.sidebarOpen === "boolean"
      ? incoming.sidebarOpen
      : current.sidebarOpen;
  const bookOpen: boolean =
    typeof incoming?.bookOpen === "boolean" ? incoming.bookOpen : current.bookOpen;
  const bookSectionOrder = coerceSectionOrder(incoming?.bookSectionOrder);
  // The Studio rail's order is the SAME class of untrusted payload, under the
  // same bounds, coerced through the same reader.
  const studioBookSectionOrder = coerceSectionOrder(
    incoming?.studioBookSectionOrder,
  );
  // The whitelist REPLACES the old `...incoming` spread. Only a declared
  // persisted key can come back from storage; everything else keeps the value
  // the store was constructed with, so an injected `runtimeMode` or
  // `currentView` in a hand-edited payload is dropped rather than merged.
  const restored: Record<string, unknown> = {};
  for (const key of PERSISTED_UI_KEYS) {
    if (incoming !== undefined && key in incoming) restored[key] = incoming[key];
  }
  return {
    ...current,
    ...(restored as Partial<UiState>),
    theme,
    themePreference,
    sidebarOpen,
    bookOpen,
    hideDustBalances,
    notificationsEnabled,
    bookSectionOrder,
    studioBookSectionOrder,
    bookTab: coerceBookTab(incoming?.bookTab),
    // THE LAST STUDIO LOCATION, narrowed before it reaches the shell's
    // top-level mode dispatch and the centre's selection. See the whitelist
    // note: the id is a candidate here and is confirmed against the settled
    // project list by `StudioCenter` before anything is opened.
    runtimeMode: coerceRuntimeMode(incoming?.runtimeMode),
    activeProjectId: coerceActiveProjectId(incoming?.activeProjectId),
    sidebarWidth: coerceSidebarWidth(incoming?.sidebarWidth),
    bookWidth: coerceBookWidth(incoming?.bookWidth),
    studioRailExplorerShare: coerceStudioRailExplorerShare(
      incoming?.studioRailExplorerShare,
    ),
    // THE FILE TABS' HOME, and the widest untrusted surface on this list: a
    // record of records, whose leaves are PATHS. Every bound and every refusal
    // is stated in `uiStore/studio-file-tabs.ts`; what survives it is still
    // only a candidate, re-resolved segment by segment through main before a
    // tab exists.
    studioFileTabs: coerceStudioFileTabs(incoming?.studioFileTabs),
  };
}
