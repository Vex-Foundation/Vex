/**
 * Shell-layout preferences: whether the Vex sidebar is open for the current
 * page class, the legacy drag widths, and the Studio rail's vertical split,
 * each with its untrusted-localStorage coercion. The pure column solver lives
 * in `lib/shell-columns.ts` (docs/design/R3-MINIMAL.md section 2); this module
 * owns the preference slots, never the geometry.
 */

import { clampWidth } from "../../lib/shell-columns.js";
import type { UiState } from "../uiStore.js";
import type { RuntimeMode } from "./runtime-mode.js";
import type { ShellRoute } from "./shell-route.js";

/* ------------------------- the Vex sidebar's page class -------------------- */

/**
 * Which stored choice opens the Vex sidebar on the current page. Vex is open
 * by default in chat (and on approvals) and hidden by default on the table
 * pages, so the two classes keep two preferences: `vexOpenChat` and
 * `vexOpenPages`. Hiding Vex on Portfolio never closes her in a chat.
 */
export type VexPageClass = "chat" | "pages";

/**
 * The table pages: Portfolio and its subpages (Agent Scan, All assets, Token
 * history), Board and Settings, plus the Lighter desk as a mode.
 */
const TABLE_PAGE_ROUTES: ReadonlySet<ShellRoute["kind"]> = new Set<ShellRoute["kind"]>([
  "portfolio",
  "agentScan",
  "assets",
  "tokenHistory",
  "board",
  "settings",
]);

export function vexPageClass(state: {
  readonly runtimeMode: RuntimeMode;
  readonly shellRoute: ShellRoute;
}): VexPageClass {
  return state.runtimeMode === "lighter" || TABLE_PAGE_ROUTES.has(state.shellRoute.kind)
    ? "pages"
    : "chat";
}

/** Whether Vex is ASKED open on the current page; the solver decides the width. */
export function selectVexOpen(
  state: Pick<UiState, "runtimeMode" | "shellRoute" | "vexOpenChat" | "vexOpenPages">,
): boolean {
  return vexPageClass(state) === "pages" ? state.vexOpenPages : state.vexOpenChat;
}

/**
 * The store patch for showing or hiding Vex on the current page: it writes the
 * current class's slot only.
 *
 * Opening also clears the narrow override, because under the medium tier an
 * open Vex folds the left sidebar to its rail (docs/design/R3-MINIMAL.md
 * section 2); in Lighter the same flag is the top bar's drawer, which an open
 * chat closes as it always has. `bookOpen` mirrors the last write: it is the
 * legacy slot that `vexOpenChat` was seeded from, and the Lighter desk still
 * watches it to focus the composer once the chat has mounted.
 */
export function vexOpenPatch(
  state: Pick<UiState, "runtimeMode" | "shellRoute">,
  open: boolean,
): Partial<
  Pick<UiState, "vexOpenChat" | "vexOpenPages" | "bookOpen" | "sidebarNarrowExpanded">
> {
  const slot = vexPageClass(state) === "pages" ? { vexOpenPages: open } : { vexOpenChat: open };
  return open
    ? { ...slot, bookOpen: true, sidebarNarrowExpanded: false }
    : { ...slot, bookOpen: false };
}

/** A persisted boolean preference: anything that is not a boolean degrades. */
export function coerceBooleanPreference(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/* ---------------------------- legacy drag widths --------------------------- */

/**
 * The left page and BOOK drag widths of the previous frame. The R3 sidebars
 * have fixed widths, so the frame no longer reads these; the slots stay
 * persisted and coerced this release (expand-only migrations), so an older
 * build reading the same payload still finds them in range.
 */
const SIDEBAR_WIDTH_MIN = 240;
const SIDEBAR_WIDTH_MAX = 420;
const BOOK_WIDTH_MIN = 300;
const BOOK_WIDTH_MAX = 520;

export const DEFAULT_SIDEBAR_WIDTH = 240;
export const DEFAULT_BOOK_WIDTH = 340;

/**
 * Coerce a persisted width payload: anything that is not a finite number
 * degrades to the default, and a numeric value re-clamps into the contract
 * range. localStorage is user-writable, so this runs on every rehydrate.
 */
function coerceWidth(
  value: unknown,
  min: number,
  max: number,
  fallback: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return clampWidth(value, min, max);
}

export function coerceSidebarWidth(value: unknown): number {
  return coerceWidth(value, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX, DEFAULT_SIDEBAR_WIDTH);
}

export function coerceBookWidth(value: unknown): number {
  return coerceWidth(value, BOOK_WIDTH_MIN, BOOK_WIDTH_MAX, DEFAULT_BOOK_WIDTH);
}

/** Clamp a legacy sidebar width write into its contract range. */
export function clampSidebarWidth(px: number): number {
  return clampWidth(px, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX);
}

/** Clamp a legacy BOOK width write into its contract range. */
export function clampBookWidth(px: number): number {
  return clampWidth(px, BOOK_WIDTH_MIN, BOOK_WIDTH_MAX);
}

/* --------------------- the Studio rail's vertical split -------------------- */

/**
 * How much of the Studio rail's list region the EXPLORER pane takes, as a share
 * of the region, with the PROJECTS list above it taking the rest.
 *
 * A SHARE rather than a pixel height, for the reason `SplitPane` states: a
 * relative size restores correctly into any window height, and this preference
 * outlives the window it was set in.
 *
 * The floors are not cosmetic. Neither pane may be dragged to nothing: a
 * zero-height PROJECTS list is a rail with no way back to another project, and
 * a zero-height explorer is the keyhole this split exists to remove.
 */
export const STUDIO_RAIL_EXPLORER_SHARE_MIN = 0.2;
export const STUDIO_RAIL_EXPLORER_SHARE_MAX = 0.8;
export const STUDIO_RAIL_EXPLORER_SHARE_DEFAULT = 0.55;

/**
 * Clamp a live drag of the rail's vertical seam.
 *
 * NOT `clampWidth`: that one ROUNDS, because it clamps whole pixels. A share is
 * a fraction, and rounding one leaves only 0 and 1 - which, re-clamped, is the
 * minimum or the maximum. Passing this through the pixel clamp made every drag
 * of the seam snap to one end of its range and the preference unsettable.
 */
export function clampStudioRailExplorerShare(share: number): number {
  if (!Number.isFinite(share)) return STUDIO_RAIL_EXPLORER_SHARE_DEFAULT;
  return Math.min(
    Math.max(share, STUDIO_RAIL_EXPLORER_SHARE_MIN),
    STUDIO_RAIL_EXPLORER_SHARE_MAX,
  );
}

/** Coerce the persisted share; anything off-shape degrades to the default. */
export function coerceStudioRailExplorerShare(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return STUDIO_RAIL_EXPLORER_SHARE_DEFAULT;
  }
  return clampStudioRailExplorerShare(value);
}
