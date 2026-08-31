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
import { coerceBookWidth, coerceSidebarWidth } from "./layout.js";

/** Hard bounds on the persisted BOOK rail order (user-writable localStorage). */
const MAX_BOOK_SECTION_ENTRIES = 32;
const MAX_BOOK_SECTION_ID_LENGTH = 32;

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
 */
export const PERSISTED_UI_KEYS = [
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
  return next;
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
    sidebarWidth: coerceSidebarWidth(incoming?.sidebarWidth),
    bookWidth: coerceBookWidth(incoming?.bookWidth),
  };
}
