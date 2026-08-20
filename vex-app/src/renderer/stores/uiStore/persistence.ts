/**
 * uiStore persistence: the partialize whitelist, expand-only version
 * migrations, and the every-rehydrate merge coercion for the user-writable
 * localStorage payload. Extracted from uiStore.ts so the store file stays a
 * readable slot registry.
 */

import type { UiState } from "../uiStore.js";
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

export function partializeUiState(state: UiState): Record<string, unknown> {
  return {
    themePreference: state.themePreference,
    sidebarOpen: state.sidebarOpen,
    bookOpen: state.bookOpen,
    sidebarWidth: state.sidebarWidth,
    bookWidth: state.bookWidth,
    hideDustBalances: state.hideDustBalances,
    notificationsEnabled: state.notificationsEnabled,
    bookSectionOrder: state.bookSectionOrder,
  };
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
  // HARD BOUND on both the list and each entry so a hand-written payload
  // cannot make the resolver walk an unbounded array. Anything off-shape
  // degrades to [] — the default order, never a crash and never a blank rail.
  const bookSectionOrder: readonly string[] =
    Array.isArray(incoming?.bookSectionOrder) &&
    incoming.bookSectionOrder.length <= MAX_BOOK_SECTION_ENTRIES &&
    incoming.bookSectionOrder.every(
      (value) =>
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_BOOK_SECTION_ID_LENGTH,
    )
      ? incoming.bookSectionOrder
      : [];
  return {
    ...current,
    ...incoming,
    theme,
    themePreference,
    hideDustBalances,
    notificationsEnabled,
    bookSectionOrder,
    sidebarWidth: coerceSidebarWidth(incoming?.sidebarWidth),
    bookWidth: coerceBookWidth(incoming?.bookWidth),
  };
}
