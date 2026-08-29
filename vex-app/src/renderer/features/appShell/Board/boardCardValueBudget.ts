/**
 * WHAT A TOKEN CARD IS WILLING TO PRINT, and how it says when it printed less.
 *
 * WHY THIS EXISTS. `global-css/board-layout.css` sizes both card modes against
 * the widest REALISTIC output (section 1 of `board-layout-measurements.md`).
 * The schema, however, permits far more than realistic: a 40-character decimal
 * (`BOARD_DECIMAL_MAX_CHARS`) and a 512-character symbol
 * (`BOARD_TOKEN_LABEL_MAX_CHARS`) both parse, and no card at any width the
 * modal can reach could show either. Until now such a value was rendered whole
 * into a `whitespace-nowrap` cell inside an `overflow-hidden` card, so the
 * reader was shown a figure with its tail cut off and NOTHING saying it had
 * been - the silent loss `.claude/CLAUDE.md` forbids outright.
 *
 * WHY A CHARACTER BUDGET AND NOT A MEASUREMENT. The alternatives are worse.
 * Reading layout back (a `ResizeObserver`, a `scrollWidth` probe) would make
 * JavaScript a second owner of a threshold the stylesheet owns and would run
 * on every card of every board. A CSS ellipsis would hide the cut without
 * reporting it, which is the defect rather than the fix. A character count is
 * a property of the DATA, decided before layout exists, and it takes no
 * threshold away from the stylesheet: it does not decide a column count, a
 * mode or a floor. It decides how much of a string is worth printing.
 *
 * WHERE EACH NUMBER COMES FROM. Each is the widest realistic string the
 * measurement matrix records for that region, in characters - which is exactly
 * the string the region's floor was derived from. A value longer than that is,
 * by construction, past what the floor was sized for, so it is the value that
 * concedes rather than the layout. Section 5 of
 * `board-layout-measurements.md` carries the derivation, and the overflow
 * assertions in `e2e/board-layout.spec.ts` are what prove the budgets hold:
 * they run over the SCHEMA-EXTREME board at the compact floor and fail if any
 * financial, stat, badge or action region scrolls.
 *
 * NOTHING IS LOST. A shortened value is marked `data-shortened` where it
 * renders, the card's disclosure says in its accessible name that values were
 * shortened, and the disclosure panel carries every whole string. The cut is
 * a reported bound, never a silent one.
 */

/** The ellipsis a shortened value ends in. */
const ELLIPSIS = "…";

/**
 * How many budget slots the ellipsis is charged.
 *
 * TWO, NOT ONE, and the number is measured rather than chosen. A budget is
 * counted in characters because the regions it guards render `tabular-nums`,
 * where every digit is the same width - but `…` is NOT one of those digits.
 * In the display face at the hero's 28px it measures about 30px against a
 * digit's 16.44, so a value shortened to exactly the budget in CHARACTERS
 * still overflowed its region by nine pixels. Charging it two slots buys
 * 1.84 digit-widths of room for a glyph that needs 1.84 of them.
 */
const ELLIPSIS_SLOTS = 2;

/**
 * Hero price. `$0.000001230` is 12 characters and 197.29px, which is the
 * string the 316px compact price row was derived from.
 */
export const BOARD_CARD_PRICE_MAX_CHARS = 12;

/** Signed 24h delta. `+661.00%` is 8 characters and 76px. */
export const BOARD_CARD_DELTA_MAX_CHARS = 8;

/**
 * A stat value. The binding mode is WIDE, not compact: four equal columns of
 * a 460px inner width leave `(460 - 3 x 12) / 4 = 106px` per column, and a
 * stat value renders at roughly 9px per character.
 */
export const BOARD_CARD_STAT_MAX_CHARS = 11;

/**
 * The ticker under the name. The compact header spends its inner width on the
 * 64px photo, two 16px gaps and the 132px action cluster, which leaves the
 * identity column 88px; the ticker renders at roughly 8.2px per character.
 */
export const BOARD_CARD_TICKER_MAX_CHARS = 10;

/** A value as the card will print it, and whether that is the whole of it. */
export interface BoardCardValue {
  readonly text: string;
  readonly shortened: boolean;
}

/**
 * The value the card prints for `text`, within `maxChars` slots INCLUDING the
 * two the ellipsis is charged.
 *
 * A value at or under the budget is printed whole; a longer one keeps
 * `maxChars - 2` characters and ends in the mark that says there was more. A
 * tiny budget is clamped rather than emptied: the shortest honest output is
 * one character and the ellipsis, because a bare `…` names no value at all.
 */
export function boardCardValue(text: string, maxChars: number): BoardCardValue {
  if (text.length <= maxChars) return { text, shortened: false };
  const kept = Math.max(1, maxChars - ELLIPSIS_SLOTS);
  return { text: `${text.slice(0, kept)}${ELLIPSIS}`, shortened: true };
}

/** True when any of the values the card printed was not the whole value. */
export function anyShortened(
  values: readonly BoardCardValue[],
): boolean {
  return values.some((value) => value.shortened);
}
