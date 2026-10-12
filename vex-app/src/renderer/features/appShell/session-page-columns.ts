/**
 * The session page's column geometry (docs/design/V10-SPREAD.md section 1:
 * centre padding 32, 24 under the 1276 spread breakpoint). One module so the
 * panel, the welcome opening and the transcript's own scroller agree on one
 * left edge without importing each other.
 */

/**
 * The READING COLUMN of a docked session: the chapter head, the transcript
 * rows, the approval cards and the composer field share it.
 */
export const PAGE_COLUMN =
  "mx-auto w-full max-w-[880px] px-8 max-[1275px]:px-6";

/**
 * The welcome opening's column: the same axis with the chapter opening's
 * wider 40px sides (reference d2), 24 under the spread breakpoint.
 */
export const OPENING_COLUMN =
  "mx-auto w-full max-w-[880px] px-10 max-[1275px]:px-6";
