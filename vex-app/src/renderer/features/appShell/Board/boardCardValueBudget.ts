/**
 * WHAT A TOKEN CARD IS WILLING TO PRINT, and how it says when it printed less.
 *
 * WHY THIS EXISTS. `global-css/board-layout.css` sizes the tile floor against
 * the widest REALISTIC output (section 1 of `board-layout-measurements.md`).
 * The schema, however, permits far more than realistic: a 40-character decimal
 * (`BOARD_DECIMAL_MAX_CHARS`) and a 512-character symbol
 * (`BOARD_TOKEN_LABEL_MAX_CHARS`) both parse, and no card at any width the
 * modal can reach could show either. Until now such a value was rendered whole
 * into a `whitespace-nowrap` cell inside an `overflow-hidden` card, so the
 * reader was shown a figure with its tail cut off and NOTHING saying it had
 * been - the silent loss `.claude/CLAUDE.md` forbids outright.
 *
 * WHY A SLOT BUDGET AND NOT A MEASUREMENT. The alternatives are worse.
 * Reading layout back (a `ResizeObserver`, a `scrollWidth` probe) would make
 * JavaScript a second owner of a threshold the stylesheet owns and would run
 * on every card of every board. A CSS ellipsis would hide the cut without
 * reporting it, which is the defect rather than the fix. A slot count is a
 * property of the DATA, decided before layout exists, and it takes no
 * threshold away from the stylesheet: it does not decide a column count or a
 * floor. It decides how much of a string is worth printing.
 *
 * WHERE EACH NUMBER COMES FROM. Each is the widest realistic string the
 * measurement matrix records for that region, in characters - which is exactly
 * the string the region's floor was derived from (or, for the stat values and
 * the ticker, the column the floor leaves). A value longer than that is,
 * by construction, past what the floor was sized for, so it is the value that
 * concedes rather than the layout. Section 5 of
 * `board-layout-measurements.md` carries the derivation, and the overflow
 * assertions in `e2e/board-layout.spec.ts` are what prove the budgets hold:
 * they run over the SCHEMA-EXTREME board at the tile floor and fail if any
 * financial, stat, badge or action region scrolls.
 *
 * NOTHING IS LOST. A shortened value is marked `data-shortened` where it
 * renders, the card's disclosure says in its accessible name that values were
 * shortened, and the disclosure panel carries every whole string. The cut is
 * a reported bound, never a silent one.
 */

/**
 * WHY THE BUDGET IS SLOTS AND NOT CHARACTERS, and why it segments first.
 *
 * `baseTokenSymbol` is `z.string().min(1).max(512)` (`src/lib/board/spec.ts`):
 * five hundred and twelve UTF-16 CODE UNITS of ANY Unicode, not 512 Latin
 * letters. The ticker also does not render in `tabular-nums` - it is ordinary
 * uppercase text - so counting `String.length` was wrong twice over:
 *
 *   - a CJK or full-width ticker is about twice as wide per character as the
 *     Latin one the budget was measured against, so a five-character ticker
 *     sat UNDER a ten-character budget, overflowed its column anyway, and -
 *     because it was under budget - reported no cut at all. Silent loss, from
 *     the module written to prevent it.
 *   - `String.prototype.slice` cuts UTF-16 code units, so a cut landing
 *     between a surrogate pair emitted a LONE SURROGATE: a broken preview,
 *     and an ill-formed string headed for the jsonb persistence boundary. A
 *     cut inside a ZWJ emoji or before a combining mark produced a preview
 *     that meant something other than the value.
 *
 * So a value is segmented into GRAPHEME CLUSTERS before anything is measured
 * or removed, and each cluster is charged in SLOTS, where one slot is the
 * width every budget below was measured in: one Latin character of that
 * region's own type.
 *
 * TWO SURFACES, TWO WIDTH MODELS, because the card has two kinds of type and
 * one model cannot describe both.
 *
 * TABULAR (`"tabular"`) is the price, the delta and the stat values. They
 * render `tabular-nums`, where every digit advances by the same width by
 * definition of the feature, so a count of clusters IS a width and one slot
 * is one digit.
 *
 * PROPORTIONAL (`"proportional"`) is the ticker. The model is measured in the
 * face the ticker renders in, Instrument Sans regular at 12.5px (not
 * uppercased and not tracked), where glyph advances differ by more than a
 * factor of four. ONE SLOT IS 9.1px: the widest glyph the allowlist below
 * admits (`V` and `A`). The advances that matter, at 12.5px:
 *
 *   W 13.61   M 11.32   Q 9.84   % O 9.82   G 9.56   D 9.40   C 9.26
 *   H N 9.20   A V 9.10   U 8.90   K 8.65   X 8.60   Y 8.45   0 8.32
 *   P R 8.20   T 8.10   E 7.97   B 7.95   Z 7.79   1 4.89   I 3.18   . , : 3.19
 *
 * So a count of characters is NOT a width here, and treating it as one was a
 * defect: `WWWWWWWW` is eight characters, cost eight of ten slots, and renders
 * 107px - more than the 91px a ten-slot ticker is allowed. A glyph charged one
 * slot is at most 9.1px and a glyph charged two is at most 18.2px (`W`, the
 * widest Latin one, is 13.6px), so a string that costs ten slots renders in at
 * most 91px. Anything measuring wider than a slot is charged two.
 *
 * THE PROPORTIONAL CLASS IS AN ALLOWLIST OF NARROW GLYPHS, not a blocklist of
 * wide ones, and that direction is the point: a character nobody measured -
 * and the schema admits any of Latin-1 - is charged the wide weight rather
 * than assumed innocent. Classification uppercases first. The tile no longer
 * forces capitals, but weighing a lowercase glyph as its capital is the safe
 * direction: every capital the allowlist charges one slot is at least as wide
 * as its lowercase (the widest lowercase among them, `p` and `b`, is 7.6px
 * against the 9.1px slot), and `m` and `w` land in the two-slot class, whose
 * 18.2px covers both.
 *
 * ABOVE LATIN-1, both surfaces charge two. That over-charges a Greek letter
 * or a base character carrying a combining mark, and under-charges nothing.
 *
 * Over-charging shortens a value slightly early AND SAYS SO; under-charging
 * overflows the card in silence. Every one of these numbers is a model of the
 * DATA owned here, and none of them takes a threshold away from
 * `global-css/board-layout.css`.
 */

/** Which of the card's two type surfaces a value is printed on. */
export type BoardCardSurface = "tabular" | "proportional";

/** The last code point charged as one slot. */
const NARROW_CODE_POINT_MAX = 0x00ff;

/** What a cluster costs when it is not narrow. */
const WIDE_SLOTS = 2;

/**
 * The glyphs measured at or under one slot (9.1px) in the ticker's type,
 * Instrument Sans 12.5px. Everything else on that surface - measured wider,
 * or never measured - is charged {@link WIDE_SLOTS}. `U` (8.9px) is left out
 * on purpose: the table is the one the budget tests pin, and charging it two
 * slots is the safe direction.
 */
const PROPORTIONAL_NARROW = new Set(
  [..."ABEFIJKLPRSTVXYZ0123456789.,:-$+ "],
);

/** The ellipsis a shortened value ends in. */
const ELLIPSIS = "…";

/**
 * How many budget slots the ellipsis is charged.
 *
 * TWO, NOT ONE, and the number is measured rather than chosen. One slot is one
 * narrow character of the region's own type, and the regions this guards
 * render `tabular-nums` where every digit is that width - but `…` is NOT one
 * of those digits.
 * In the display face at the hero's 28px it measures about 30px against a
 * digit's 16.44, so a value shortened to exactly the budget in CHARACTERS
 * still overflowed its region by nine pixels. Charging it two slots buys
 * 1.84 digit-widths of room for a glyph that needs 1.84 of them.
 */
const ELLIPSIS_SLOTS = 2;

/**
 * Price. `$0.000001230` is 12 characters and 177.84px in JetBrains Mono 26 /
 * 500 at -.03em (12 x 14.82), which is the string the tile's 280px price row
 * was derived from.
 */
export const BOARD_CARD_PRICE_MAX_SLOTS = 12;

/** Signed 24h delta. `+661.00%` is 8 characters and 61.36px (8 x 7.67). */
export const BOARD_CARD_DELTA_MAX_SLOTS = 8;

/**
 * A stat value, in JetBrains Mono 13 where a character advances 7.67px. The
 * four stats share one row at every width, so the binding column is the one
 * the floor leaves: `(282 - 3 x 6) / 4 = 66px`, and `8 x 7.67 = 61.4px` fits
 * it where nine characters (69px) would not. The widest value the formatters
 * can produce for a real market is 8 characters (`$1234.5B`), so a realistic
 * figure is never cut.
 */
export const BOARD_CARD_STAT_MAX_SLOTS = 8;

/**
 * The ticker on the line under the name, and the one PROPORTIONAL surface.
 *
 * The header spends the floor's 282px on the 34px photo, two 11px gaps, the
 * 26px key, a 6px gap and the 74px Spotlight chip, which leaves the identity
 * column 120px. A ten-slot string renders in at most ten slots of 9.1px, or
 * 91px, so the budget keeps the ticker inside its own column with 29px to
 * spare for the separator and the chain name. The chain name is what concedes
 * when a ten-slot ticker meets a long chain (it ellipsizes, whole in its
 * `title` and in the disclosure); the ticker itself is never cut by CSS.
 * Realistic tickers (`BITCOIN` is 50px) leave the widest known chain name,
 * `Robinhood`, its whole 63px.
 */
export const BOARD_CARD_TICKER_MAX_SLOTS = 10;

/** A value as the card will print it, and whether that is the whole of it. */
export interface BoardCardValue {
  readonly text: string;
  readonly shortened: boolean;
}

/**
 * `text` split into grapheme clusters.
 *
 * `Intl.Segmenter` is the only correct answer for a family emoji or a base
 * character carrying two combining marks, and it is present in Electron 42's
 * V8 and in the Node the tests run on. The fallback iterates CODE POINTS,
 * which is weaker about clusters but still cannot produce a lone surrogate -
 * so the persistence-boundary guarantee holds on either path.
 */
function graphemesOf(text: string): readonly string[] {
  const segmenter = graphemeSegmenter();
  if (segmenter === null) return [...text];
  return [...segmenter.segment(text)].map((entry) => entry.segment);
}

/**
 * ONE SEGMENTER FOR THE PROCESS, built on first use.
 *
 * `new Intl.Segmenter()` loads ICU locale data and is genuinely expensive.
 * Constructing one PER VALUE - which is six values on each of eight cards,
 * on every board render - was expensive enough to show up as a slower test
 * suite, and it is the kind of per-row cost rule 05 exists to catch. The
 * segmenter is a pure function of nothing, so process lifetime is the correct
 * one; it is built lazily rather than at import so a runtime without
 * `Intl.Segmenter` pays nothing and takes the fallback above.
 */
let segmenterCache: Intl.Segmenter | null | undefined;

function graphemeSegmenter(): Intl.Segmenter | null {
  if (segmenterCache === undefined) {
    segmenterCache =
      typeof Intl.Segmenter === "function"
        ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
        : null;
  }
  return segmenterCache;
}

/** What one cluster costs, under the width models in this file's head note. */
function slotsOf(grapheme: string, surface: BoardCardSurface): number {
  for (const codePoint of grapheme) {
    const value = codePoint.codePointAt(0);
    if (value === undefined || value > NARROW_CODE_POINT_MAX) return WIDE_SLOTS;
  }
  if (surface === "tabular") return 1;
  // Uppercased first: a lowercase `w` is charged as the `W` it would be if
  // capitals were forced, which is never narrower than the glyph that
  // renders (see the head note).
  for (const character of grapheme.toUpperCase()) {
    if (!PROPORTIONAL_NARROW.has(character)) return WIDE_SLOTS;
  }
  return 1;
}

/** What `text` costs in slots, whole. Exported because the tests assert it. */
export function boardCardValueSlots(
  text: string,
  surface: BoardCardSurface = "tabular",
): number {
  let slots = 0;
  for (const grapheme of graphemesOf(text)) slots += slotsOf(grapheme, surface);
  return slots;
}

/**
 * The value the card prints for `text`, within `maxSlots` INCLUDING the two
 * the ellipsis is charged.
 *
 * A value at or under the budget is printed whole; a longer one keeps as many
 * WHOLE clusters as fit in `maxSlots - 2` and ends in the mark that says
 * there was more. A cut never lands inside a cluster, so no lone surrogate,
 * no half of a ZWJ sequence and no orphaned combining mark can be emitted.
 *
 * One cluster always survives, even when it costs more than the whole budget:
 * a bare `…` names no value at all, and the clamp is one cluster over rather
 * than a preview that says nothing.
 */
export function boardCardValue(
  text: string,
  maxSlots: number,
  surface: BoardCardSurface = "tabular",
): BoardCardValue {
  // SEGMENTED ONCE. The whole-value cost and the kept prefix are two questions
  // about the same clusters, and asking the segmenter twice is a per-row cost
  // on every value of every card.
  const graphemes = graphemesOf(text);
  const costs = graphemes.map((grapheme) => slotsOf(grapheme, surface));
  let total = 0;
  for (const cost of costs) total += cost;
  if (total <= maxSlots) return { text, shortened: false };

  const budget = Math.max(1, maxSlots - ELLIPSIS_SLOTS);
  let used = 0;
  let kept = "";
  for (const [index, grapheme] of graphemes.entries()) {
    const cost = costs[index] ?? 1;
    if (used + cost > budget) break;
    used += cost;
    kept += grapheme;
  }
  if (kept === "") kept = graphemes[0] ?? "";
  return { text: `${kept}${ELLIPSIS}`, shortened: true };
}

/** True when any of the values the card printed was not the whole value. */
export function anyShortened(
  values: readonly BoardCardValue[],
): boolean {
  return values.some((value) => value.shortened);
}
