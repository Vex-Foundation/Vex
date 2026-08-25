/**
 * The REJECT-ONLY text predicate for every model-authored string in a board
 * spec.
 *
 * Lives in `src/lib/` (the pure shared root) so that ONE definition of "which
 * code points may appear in board text" is reachable from the agent runtime
 * (`src/vex-agent`, relative import) and from the Electron app's shared, main
 * and renderer trees (`@vex-lib/board/board-text.js`). A second copy would be a
 * second answer to a security question, which is the failure this module
 * exists to prevent.
 *
 * WHY REJECT AND NOT SANITIZE. `src/tools/dexscreener/sanitize.ts` owns the
 * opposite policy for the opposite input: PROVIDER text arrives as it arrives,
 * cannot be refused, and is therefore cleaned and the cleaning is reported. A
 * board string is different in kind - the model AUTHORS it, and an author can
 * be told no. Transforming it would silently change what the model asked to
 * display and would hand the model a channel it can probe for the transform's
 * edges. So this module never returns a modified string: it returns the NAME
 * of the class that was found, or null.
 *
 * The code-point table is deliberately the same table as the sanitizer's, with
 * one deliberate divergence recorded here: the sanitizer KEEPS TAB, LF and CR
 * because removing layout a reader can see is the one thing it never does;
 * this predicate REJECTS TAB and CR everywhere, and rejects LF except in the
 * fields the caller declares multi-line. Nothing is removed either way.
 *
 * Failures name the FIELD and the CLASS and never echo the offending bytes: an
 * error message is model-visible and reader-visible text, and echoing an
 * injected bidi run or a tag-block sentence into it would carry the payload
 * into exactly the surface the check was defending.
 */

/**
 * The classes a board string may be rejected for.
 *
 * Each name is model-visible (it appears in the validation error) and is
 * therefore written to be actionable on its own: a model reading
 * `zero-width` knows to remove invisible characters without being shown them.
 */
export type ForbiddenTextClass =
  /** C0 controls (except LF), DEL, and the C1 block. Includes TAB and CR. */
  | "control-character"
  /** A line break in a field declared single-line. */
  | "line-break"
  /** Bidi embeddings, overrides and isolates - the Trojan Source class. */
  | "bidi-control"
  /** Unicode tag characters - invisible ASCII twins. */
  | "unicode-tag"
  /** Zero-width and other invisible formatting characters (U+200D excluded). */
  | "zero-width";

interface ForbiddenRange {
  readonly low: number;
  readonly high: number;
  readonly textClass: ForbiddenTextClass;
}

/**
 * The rejection table, written as numbers.
 *
 * Code points rather than literal characters for the same reason the sanitizer
 * gives: a source file containing the characters it rejects is unreviewable -
 * a reader cannot see them, a diff cannot show them, and an editor can drop
 * one silently.
 *
 * LF (U+000A) is absent from the table because it is conditional: see
 * {@link findForbiddenTextClass}. U+200D ZERO WIDTH JOINER is absent because
 * it is load-bearing inside legitimate emoji sequences, and a caption
 * containing an emoji is a normal caption, not an attack.
 */
const FORBIDDEN_RANGES: readonly ForbiddenRange[] = [
  { low: 0x0000, high: 0x0009, textClass: "control-character" }, // NUL..TAB
  { low: 0x000b, high: 0x001f, textClass: "control-character" }, // VT..US (LF handled separately)
  { low: 0x007f, high: 0x009f, textClass: "control-character" }, // DEL and the C1 block
  { low: 0x00ad, high: 0x00ad, textClass: "zero-width" }, // SOFT HYPHEN
  { low: 0x180e, high: 0x180e, textClass: "zero-width" }, // MONGOLIAN VOWEL SEPARATOR
  { low: 0x200b, high: 0x200c, textClass: "zero-width" }, // ZWSP, ZWNJ (U+200D kept)
  { low: 0x200e, high: 0x200f, textClass: "zero-width" }, // LRM, RLM
  { low: 0x202a, high: 0x202e, textClass: "bidi-control" }, // embeddings and overrides
  { low: 0x2060, high: 0x2064, textClass: "zero-width" }, // WORD JOINER..INVISIBLE PLUS
  { low: 0x2066, high: 0x2069, textClass: "bidi-control" }, // isolates
  { low: 0xfeff, high: 0xfeff, textClass: "zero-width" }, // BOM / ZWNBSP
  { low: 0xe0001, high: 0xe0001, textClass: "unicode-tag" }, // LANGUAGE TAG
  { low: 0xe0020, high: 0xe007f, textClass: "unicode-tag" }, // TAG SPACE..CANCEL TAG
];

const LINE_FEED = 0x000a;

/**
 * The first forbidden class present in `value`, or null when the string is
 * acceptable.
 *
 * Scans by CODE POINT, not by UTF-16 unit, so an astral character is never
 * examined as two unrelated halves. Total and pure; allocates nothing.
 *
 * @param multiline when true, LF is permitted. Every other control character,
 *   TAB and CR included, is rejected either way.
 */
export function findForbiddenTextClass(
  value: string,
  multiline: boolean
): ForbiddenTextClass | null {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (codePoint === LINE_FEED) {
      if (multiline) continue;
      return "line-break";
    }
    for (const range of FORBIDDEN_RANGES) {
      if (codePoint >= range.low && codePoint <= range.high) {
        return range.textClass;
      }
    }
  }
  return null;
}

/**
 * Length of `value` in CODE POINTS.
 *
 * Board bounds are stated in characters a reader perceives, so a four-byte
 * emoji counts as one. `String.prototype.length` would count it as two and
 * would make an 80-character title budget mean something different depending
 * on the alphabet used.
 */
export function textLength(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

/** Declared shape of one board text field. */
export interface BoardTextRule {
  /** Minimum code points, inclusive. */
  readonly minChars: number;
  /** Maximum code points, inclusive. */
  readonly maxChars: number;
  /** When false, LF is rejected along with every other control character. */
  readonly multiline: boolean;
}

/**
 * Why one board string was refused.
 *
 * Carries no fragment of the offending value by design - see the module note.
 * `length` is present only for the length failures, where the number is the
 * actionable fact and is not attacker-controlled content.
 */
export type BoardTextFailure =
  | { readonly reason: "too-short"; readonly minChars: number; readonly length: number }
  | { readonly reason: "too-long"; readonly maxChars: number; readonly length: number }
  | { readonly reason: "forbidden-characters"; readonly textClass: ForbiddenTextClass };

/**
 * Check one board string against its rule.
 *
 * Returns null when the string is acceptable. The character-class check runs
 * BEFORE the length checks are reported so that a string which is both too
 * long and carries a bidi override is named for the security class first: the
 * length is a budgeting fact, the class is the reason the string can never be
 * accepted at any length.
 */
export function checkBoardText(
  value: string,
  rule: BoardTextRule
): BoardTextFailure | null {
  const textClass = findForbiddenTextClass(value, rule.multiline);
  if (textClass !== null) return { reason: "forbidden-characters", textClass };
  const length = textLength(value);
  if (length < rule.minChars) {
    return { reason: "too-short", minChars: rule.minChars, length };
  }
  if (length > rule.maxChars) {
    return { reason: "too-long", maxChars: rule.maxChars, length };
  }
  return null;
}

/**
 * The model-visible sentence for one failure.
 *
 * The caller prefixes the field path; this function owns the reason clause, so
 * every board text rejection in the product reads the same way.
 */
export function describeBoardTextFailure(failure: BoardTextFailure): string {
  switch (failure.reason) {
    case "too-short":
      return `must be at least ${failure.minChars} character(s), received ${failure.length}`;
    case "too-long":
      return `must be at most ${failure.maxChars} character(s), received ${failure.length}`;
    case "forbidden-characters":
      return `contains forbidden characters of class "${failure.textClass}"; remove them and send the text again (the offending characters are not echoed back)`;
  }
}
