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
