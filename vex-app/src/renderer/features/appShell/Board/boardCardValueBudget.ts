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
 * WHY A SLOT BUDGET AND NOT A MEASUREMENT. The alternatives are worse.
 * Reading layout back (a `ResizeObserver`, a `scrollWidth` probe) would make
 * JavaScript a second owner of a threshold the stylesheet owns and would run
 * on every card of every board. A CSS ellipsis would hide the cut without
 * reporting it, which is the defect rather than the fix. A slot count is a
 * property of the DATA, decided before layout exists, and it takes no
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
 * PROPORTIONAL (`"proportional"`) is the ticker, which renders in ordinary
 * uppercase Inter Tight (`TokenCardV3.tsx`) where glyph advances differ by
 * more than a factor of four. Measured in the committed face at the ticker's
 * own 13px, one slot is 8.8px - the 88px identity column divided by the
 * budget of 10 - and the glyphs fall either side of it:
 *
 *   W 11.82   M 10.84   % 9.85   C D G H N O Q U 8.86
 *   A B K P R S T V X Y Z $ + 0 3 4 7.88   E F L 2 5 6 7 8 9 6.90
 *   J 5.91   1 - 4.93   I . , : 2.95
 *
 * So a count of characters is NOT a width here, and treating it as one was a
 * defect: `WWWWWWWW` is eight characters, cost eight of ten slots, and
 * rendered 94.56px into an 88px column - clipped, with nothing reporting it.
 * Anything measuring wider than a slot is charged two.
 *
 * THE PROPORTIONAL CLASS IS AN ALLOWLIST OF NARROW GLYPHS, not a blocklist of
 * wide ones, and that direction is the point: a character nobody measured -
 * and the schema admits any of Latin-1 - is charged the wide weight rather
 * than assumed innocent. The ticker also renders through `text-transform:
 * uppercase`, so classification uppercases first: a lowercase `w` occupies a
 * `W`.
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
 * The glyphs measured at or under one slot (8.8px) in the ticker's own type,
 * after its `uppercase` transform. Everything else on that surface - measured
 * wider, or never measured - is charged {@link WIDE_SLOTS}.
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
 * Hero price. `$0.000001230` is 12 characters and 197.29px, which is the
 * string the 316px compact price row was derived from.
 */
export const BOARD_CARD_PRICE_MAX_SLOTS = 12;

/** Signed 24h delta. `+661.00%` is 8 characters and 76px. */
export const BOARD_CARD_DELTA_MAX_SLOTS = 8;

/**
 * A stat value. The binding mode is WIDE, not compact: four equal columns of
 * a 460px inner width leave `(460 - 3 x 12) / 4 = 106px` per column, and a
 * stat value renders at roughly 9px per character.
 */
export const BOARD_CARD_STAT_MAX_SLOTS = 11;

/**
 * The ticker under the name, and the one PROPORTIONAL surface.
 *
 * The compact header spends its inner width on the 64px photo, two 16px gaps
 * and the 132px action cluster, which leaves the identity column 88px. Ten
 * slots of 8.8px each is that column exactly, which is what makes 8.8px the
 * slot on this surface and what the glyph table in the head note is measured
 * against. The widest a ten-slot string can render is ten narrow glyphs at
 * 7.88px, or 78.8px, so the model keeps 9px in hand against its own column.
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
  // Uppercased first: the ticker renders through `text-transform: uppercase`,
  // so a lowercase `w` occupies a `W` and must be charged as one.
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
