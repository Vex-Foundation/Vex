/**
 * Shell-layout width preferences: the persisted sidebar/BOOK drag widths and
 * their untrusted-localStorage coercion. The pure column solver that consumes
 * them lives in `lib/shell-columns.ts`; this module only owns the preference
 * slots' defaults and bounds.
 */

import {
  BOOK_DEFAULT,
  BOOK_MAX,
  BOOK_MIN,
  clampWidth,
  SIDEBAR_DEFAULT,
  SIDEBAR_MAX,
  SIDEBAR_MIN,
} from "../../lib/shell-columns.js";

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
  return coerceWidth(value, SIDEBAR_MIN, SIDEBAR_MAX, SIDEBAR_DEFAULT);
}

export function coerceBookWidth(value: unknown): number {
  return coerceWidth(value, BOOK_MIN, BOOK_MAX, BOOK_DEFAULT);
}

/** Clamp a live sidebar drag into the contract range. */
export function clampSidebarWidth(px: number): number {
  return clampWidth(px, SIDEBAR_MIN, SIDEBAR_MAX);
}

/** Clamp a live BOOK drag into the contract range. */
export function clampBookWidth(px: number): number {
  return clampWidth(px, BOOK_MIN, BOOK_MAX);
}

export const DEFAULT_SIDEBAR_WIDTH = SIDEBAR_DEFAULT;
export const DEFAULT_BOOK_WIDTH = BOOK_DEFAULT;

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
